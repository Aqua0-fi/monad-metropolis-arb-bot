// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

// forgefmt: disable-start
//
//         █████╗  ██████╗ ██╗   ██╗ █████╗  ██████╗
//        ██╔══██╗██╔═══██╗██║   ██║██╔══██╗██╔═████╗
//        ███████║██║   ██║██║   ██║███████║██║██╔██║
//        ██╔══██║██║▄▄ ██║██║   ██║██╔══██║████╔╝██║
//        ██║  ██║╚██████╔╝╚██████╔╝██║  ██║╚██████╔╝
//        ╚═╝  ╚═╝ ╚══▀▀═╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝
//
//        Cross-Chain Shared Liquidity Protocol
//
// forgefmt: disable-end

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import { IPoolManager } from "@uniswap/v4-core/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/interfaces/IHooks.sol";
import { Hooks } from "@uniswap/v4-core/libraries/Hooks.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/types/PoolKey.sol";
import { BalanceDelta } from "@uniswap/v4-core/types/BalanceDelta.sol";
import { BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta } from "@uniswap/v4-core/types/BeforeSwapDelta.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/types/PoolOperation.sol";
import { Currency } from "@uniswap/v4-core/types/Currency.sol";
import { TransientStateLibrary } from "@uniswap/v4-core/libraries/TransientStateLibrary.sol";

import { BaseHook } from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";

import { Roles } from "../lib/Roles.sol";
import { Events } from "../lib/Events.sol";
import { Errors } from "../lib/Errors.sol";
import { V4Types } from "../lib/Types.sol";
import { IVenueAdapter } from "../interface/IVenueAdapter.sol";
import { IVaultRegistry } from "../interface/IVaultRegistry.sol";
import { IAssetVault } from "../interface/IAssetVault.sol";
import { Alloc } from "../lib/Types.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title V4Adapter
/// @author Aqua0 Team
/// @notice Uniswap V4 hook that provides just-in-time (JIT) liquidity for the multi-class asset vaults. A
///         backend-signed payload authorizes a swap and attributes it to a consent class; `beforeSwap`
///         injects the signed ranges, and `afterSwap` removes them and settles the swap-induced NET currency
///         delta per token against THAT token's vault, keyed by the shared `classId` (a pool spans two
///         per-asset vaults). Value-PnL is attributed off-chain from the emitted `V4SwapSettled` feed.
/// @dev Hook-reactive `IVenueAdapter`. Inherits OpenZeppelin's `BaseHook`, which defines the full `IHooks`
///      surface and reverts (`HookNotImplemented`) on every callback whose permission bit is off; this adapter
///      only overrides `_beforeSwap`/`_afterSwap`, so the eight unused callbacks live in the (out-of-scope)
///      base and never enter the audited surface. `BaseHook` resolves against the project's own `v4-core` via
///      the `lib/uniswap-hooks/` remapping (foundry.toml), so its `IHooks`/`PoolKey`/`IPoolManager` types are
///      identical to this adapter's and the mocks still apply. The hook address must be mined so its low bits
///      encode the `beforeSwap`/`afterSwap` permissions; `BaseHook`'s constructor asserts this via
///      `Hooks.validateHookPermissions`. Settlement is PER CLASS: only the swap-induced net delta touches a
///      vault, and it settles from
///      the strategy class's OWN idle (bounded by it); never another class's capital. The capital
///      efficiency is per strategy (a class provides JIT notional far exceeding its balance because only the
///      small net delta settles), not cross-class pooling. The signed payload is verified ADAPTER-side (own
///      EIP-712 domain + per-adapter nonce namespace) because no operator is in the trader-driven mid-swap
///      call stack. A guardian can pause the adapter as an instant circuit-breaker against a compromised
///      signer; `backendSigner` is admin-rotatable (a hot key, deliberately NOT timelocked so a leak can be
///      rotated immediately). Directly deployed (non-proxy); `AccessControl` + keccak roles gate admin.
contract V4Adapter is IVenueAdapter, BaseHook, AccessControl, Pausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using TransientStateLibrary for IPoolManager;

    /// @notice Stable venue identifier for Uniswap V4.
    bytes32 public constant override venueId = keccak256("V4");

    /// @notice Magic prefix in `hookData` identifying an Aqua0 JIT payload (non-JIT swaps pass untouched).
    /// @dev `beforeSwap` reads only the first word of `hookData` and returns early unless it equals this, so an
    ///      ordinary V4 swap that happens to carry other hook data is never misread as a JIT payload.
    bytes32 public constant AQUA0_MAGIC = keccak256("AQUA0_JIT_PAYLOAD");

    /// @notice Denominator for `protocolFeePpb`: the rate is PARTS PER BILLION, so 1e9 == 100%.
    /// @dev Matches the unit `AquaAdapter` already uses for `feePpb`, so one rate means the same thing on
    ///      both venues and a rate copied between them cannot silently change magnitude. 30 bps is
    ///      3_000_000, not 30.
    uint32 public constant PROTOCOL_FEE_DENOMINATOR_PPB = 1_000_000_000;

    /// @notice Ceiling on `protocolFeePpb` (1%), enforced in `setProtocolFee`.
    /// @dev Two jobs. It bounds a fat-fingered or compromised admin to a survivable rate, and it keeps the
    ///      fee far away from the swap amount itself: `beforeSwap` shrinks an exact-input swap by the fee, so
    ///      an uncapped rate could drive the amount actually swapped to zero, which would leave the pool
    ///      trading nothing while the whole input was skimmed. At 1% the fee can never approach the
    ///      specified amount, so that degenerate shape is unreachable by construction rather than by review.
    uint32 public constant MAX_PROTOCOL_FEE_PPB = 10_000_000;

    /// @notice Max liquidity ranges per JIT injection; bounds the per-swap `modifyLiquidity` loop.
    /// @dev Enforced in `_verifyAndRecordSwap`, so both the inject loop and the `afterSwap` remove loop are
    ///      bounded and cannot be gas-griefed by an over-long signed range array.
    uint256 public constant MAX_JIT_RANGES = 16;

    /// @notice Largest single-currency residue, in wei, that a JIT inject/remove pair can leave un-netted.
    /// @dev v4-core rounds an ADD up and a REMOVE down, so a band the swap never crossed nets a few wei owed
    ///      on that band's one non-zero currency. `getAmount0Delta` rounds twice (a `mulDiv` then a divide),
    ///      putting the ceil/floor gap at most 2 wei per range; `getAmount1Delta` rounds once, so at most 1.
    ///      Two wei per range across `MAX_JIT_RANGES` bounds the aggregate. `_settleSingle` sources up to this
    ///      much from the class's vault and refuses anything larger, which is not reachable from that pair.
    uint256 public constant MAX_JIT_ROUNDING_DUST = 2 * MAX_JIT_RANGES;

    // Transient-storage (EIP-1153) slot labels. Every per-swap JIT datum lives at
    // `keccak256(abi.encode(poolId, label[, rangeIndex]))`, so two swaps on different pools inside one
    // PoolManager unlock write disjoint slots and never collide. Transient (not persistent) storage is
    // load-bearing: the data is valid ONLY between this pool's `beforeSwap` and `afterSwap` within a single
    // unlock, and MUST be gone afterward so a later swap cannot read a stale range/class/swap id.
    /// @dev Slot label for a pool's injected-range count (the loop bound `afterSwap` reads to remove them).
    bytes32 private constant TSLOT_LABEL_RANGE_COUNT = keccak256("aqua0.v4f.tslot.rangeCount");
    /// @dev Slot label for a range's lower tick, indexed per range.
    bytes32 private constant TSLOT_LABEL_TICK_LOWER = keccak256("aqua0.v4f.tslot.tickLower");
    /// @dev Slot label for a range's upper tick, indexed per range.
    bytes32 private constant TSLOT_LABEL_TICK_UPPER = keccak256("aqua0.v4f.tslot.tickUpper");
    /// @dev Slot label for a range's liquidity amount, indexed per range.
    bytes32 private constant TSLOT_LABEL_LIQUIDITY = keccak256("aqua0.v4f.tslot.liquidity");
    /// @dev Slot label for the swap id that authorized this pool's injection (settlement attribution key).
    bytes32 private constant TSLOT_LABEL_SWAP_ID = keccak256("aqua0.v4f.tslot.swapId");
    /// @dev Slot label for the consent class the swap was attributed to (the vault the delta settles against).
    bytes32 private constant TSLOT_LABEL_CLASS_ID = keccak256("aqua0.v4f.tslot.classId");
    /// @dev Slot label for the protocol fee `beforeSwap` charged on this pool's swap, which `afterSwap` takes.
    ///      Carried transiently rather than recomputed in `afterSwap` so the amount TAKEN is provably the same
    ///      amount CHARGED: the two are one write and one read of a single slot, not two derivations that a
    ///      later reader has to prove equal.
    bytes32 private constant TSLOT_LABEL_PROTOCOL_FEE = keccak256("aqua0.v4f.tslot.protocolFee");

    /// @notice EIP-712 type hash for the JIT payload (binds swap params + class + ranges + executor).
    /// @dev Every field a swap could be manipulated on (direction, amount, price limit) and the class,
    ///      ranges hash, and executor are in the signed struct, so the signature authorizes one exact trade,
    ///      one exact set of liquidity ranges, and one exact triggering router, nothing adjacent.
    bytes32 public constant V4_JIT_TYPEHASH = keccak256(
        "JIT(bytes32 swapId,bytes32 poolId,uint256 classId,bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96,uint256 nonce,uint256 deadline,address executor,bytes32 rangesHash)"
    );

    /// @notice EIP-712 type hash for a class strategist's pool-approval / revocation
    ///         (`approveClassForPool` / `revokeClassForPool`). `approved` is part of the signed struct so the
    ///         SAME struct shape signs both directions and a signature can never be replayed to mean the
    ///         opposite of what the strategist intended.
    bytes32 public constant CLASS_APPROVAL_TYPEHASH =
        keccak256("ClassApproval(bytes32 poolId,uint256 classId,bool approved,uint256 nonce,uint256 deadline)");

    /// @dev Standard EIP-712 domain typehash. The domain binds `chainId` and `verifyingContract`, so a
    ///      payload signed for this adapter on this chain cannot be replayed on another adapter or chain.
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @dev EIP-712 domain name is a frozen wire constant, NOT the contract name. It coincides with the
    ///      contract name today; migrated from `Aqua0V4FleetAdapter` on 2026-07-10 under a founder-approved
    ///      one-off, while nothing signed this domain; but it does not track it. The backend signs against
    ///      this string, so renaming the contract must not rotate it: doing so invalidates every in-flight
    ///      signature and requires a coordinated backend rollout. Pinned by test/vault/EIP712Domains.t.sol.
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("V4Adapter");
    /// @notice EIP-712 domain version hash, `keccak256(version)`, bound at construction.
    /// @dev A deploy parameter, not a constant, because name, chainId and verifyingContract are all
    ///      reproducible off a fork: a fork keeps the forked chain's id, and a mined address is init-code
    ///      derived, so without a distinct version a payload signed against a fork deployment is structurally
    ///      valid against the mainnet one. Mainnet passes `"1"` (the frozen wire value the backend signs
    ///      against); a fork passes something else. Bumping the mainnet value invalidates every
    ///      previously-signed payload, so it moves only under a backend-coordinated signature-format migration.
    bytes32 public immutable DOMAIN_VERSION_HASH;

    /// @dev VaultRegistry used to resolve each currency's vault for settlement, and the source of the permanent
    ///      `isVaultedAsset` flag the rescue path keys on. Immutable; exposed read-only via `registry()`.
    address internal immutable _registry;

    /// @notice Backend EIP-712 signer whose signature authorizes every JIT payload. Admin-rotatable.
    /// @dev A hot key by design: no operator sits in the mid-swap stack, so this signature is the sole
    ///      authorization for injection. Rotated immediately on a leak (`setBackendSigner`); the guardian pause
    ///      and the vault outflow meter bound the exposure window, not a timelock.
    address public backendSigner;

    /// @notice JIT position configuration keyed by PoolId.
    /// @dev Set permissionlessly via `setJITPosition`; both tokens are pinned to registry vaults at set time,
    ///      so the settle path can always resolve a vault for each currency, and arming is therefore limited to
    ///      pools over the protocol's own vaulted assets (`createVault` stays timelocked).
    mapping(PoolId => V4Types.JITPositionInfo) public jitPositions;

    /// @notice The account whose permissionless `setJITPosition` armed a pool. Zero for an unarmed pool.
    /// @dev Recorded so `removeJITPosition` can be self-gated to the registrant (or an admin janitor), which is
    ///      what stops a second arbitrary caller from disarming a pool a strategist relies on. Cleared on remove.
    mapping(PoolId => address) public jitRegistrant;

    /// @notice Consumed signer nonces (per-adapter namespace, single-use replay protection).
    /// @dev A nonce is burned inside `_verifyAndRecordSwap` only AFTER the swap-match checks pass, so a
    ///      mismatched swap cannot spend a legitimate payload's one-shot nonce. This namespace is local to this
    ///      adapter; it does not interact with any vault or other adapter nonce space.
    mapping(uint256 => bool) public usedNonces;

    /// @notice Routers permitted to trigger JIT consumption when the allowlist is enforced.
    mapping(address => bool) public jitTriggerRouterAllowed;

    /// @notice Per-pool, per-class strategist consent: `classId` may only settle against `poolId` once its
    ///         registered class strategist (agreed by BOTH the pool's vaults, mirroring Aqua's
    ///         `_commitShipTokens` cross-vault check) has signed an approval. Mirrors the strategist gate
    ///         Aqua already enforces before a class's capital ships:
    ///         `backendSigner` is a hot, non-timelocked key that authorizes the swap MECHANICS (direction,
    ///         amount, price, ranges) per trade, but was never required to prove the class's OWNER consented
    ///         to THIS pool at all - a leaked backendSigner could attribute settlement to any registered
    ///         class on the vault. This mapping is the missing consent check `_verifyAndRecordSwap` enforces.
    mapping(PoolId => mapping(uint256 => bool)) public classApprovedForPool;

    /// @notice Sequential per-strategist nonce for `approveClassForPool` / `revokeClassForPool` (separate
    ///         namespace from `usedNonces`, which is per-swap and burned by the backend signer instead).
    mapping(address => uint256) public strategistNonces;

    /// @notice When true, `beforeSwap` requires the `sender` router to be allowlisted before consuming JIT.
    /// @dev On by default (set in the constructor): the per-payload `executor` binding is the primary defense
    ///      against a replayed swap being triggered through a different router, and this allowlist is the
    ///      curated defense-in-depth backstop, so a fresh deployment starts hardened rather than open. An
    ///      admin must explicitly allowlist a router (`setJitTriggerRouterAllowed`) before any JIT-consuming swap can
    ///      land.
    bool public jitTriggerAllowlistEnabled;

    /// @notice Protocol-fee rate in PARTS PER BILLION (1e9 == 100%), charged on the swapper's SPECIFIED amount.
    /// @dev Zero by default, so a fresh deployment charges nothing. Distinct from BOTH the pool's own Uniswap
    ///      LP fee (which this hook never overrides; `beforeSwap` always returns a zero fee override) and the
    ///      LP's JIT earnings (which settle to the class's vaults untouched). Bounded by `MAX_PROTOCOL_FEE_PPB`.
    uint32 public protocolFeePpb;

    /// @notice The Aqua0-controlled account protocol fees accrue to. Zero disarms the seam.
    /// @dev Packs into the same slot as `jitTriggerAllowlistEnabled` and `protocolFeePpb` (1 + 4 + 20 = 25
    ///      bytes), so the seam adds NO new storage slot and the hot path reads all three in one SLOAD.
    ///      The zero default is what makes the adapter ship INERT: `_chargeProtocolFee` returns before
    ///      computing anything, so a swap on an unconfigured adapter takes the exact path it took before this
    ///      seam existed - no fee branch, no transient write, no `take`, and a ZERO before-swap delta.
    address public protocolFeeRecipient;

    /// @notice Per-pool protocol-fee rate overrides. A pool without one is charged `protocolFeePpb`.
    /// @dev Rate only; the RECIPIENT stays global on purpose. Per-pool recipients would multiply the trust
    ///      surface - every pool a separate place funds can be routed to - for no product reason, and would
    ///      turn the inert check into a sweep over pools instead of one storage read.
    ///
    ///      `V4Types.PoolProtocolFee.set` is what lets an operator waive the fee on a pair by writing 0
    ///      without that being read back as "no override"; the struct's own note is where that reasoning
    ///      lives. Resolution is exactly two steps and no more: this override, then the global rate. See
    ///      `_resolveProtocolFeePpb`.
    ///
    ///      Overrides do NOT survive the inert gate. `protocolFeeRecipient == 0` short-circuits before this
    ///      mapping is ever read, so an adapter with overrides configured but no recipient still charges
    ///      nothing, and `recipient == 0` keeps meaning "inert" as a single on-chain read.
    mapping(PoolId => V4Types.PoolProtocolFee) public poolProtocolFee;

    /// @notice Deploy and bind the adapter.
    /// @param poolManager_ The Uniswap V4 PoolManager (non-zero).
    /// @param registry_    The VaultRegistry this adapter resolves currency->vault against (non-zero).
    /// @param admin        Receives `DEFAULT_ADMIN_ROLE` (JIT config, signer rotation, allowlist, rescue).
    /// @param signer       The backend EIP-712 signer authorizing JIT payloads (non-zero).
    /// @param domainVersion The EIP-712 domain version; `"1"` on mainnet, a distinct value on a fork so a
    ///                      fork-minted signature cannot validate against the mainnet deployment. Empty is
    ///                      refused, since it is what an omitted argument passes.
    /// @dev `BaseHook(poolManager_)` binds the immutable PoolManager AND asserts the mined hook address (its low
    ///      bits must encode exactly `beforeSwap`/`afterSwap`) via `Hooks.validateHookPermissions`; that base
    ///      constructor runs before this body, so the address check precedes the zero-address checks here.
    constructor(
        IPoolManager poolManager_,
        address registry_,
        address admin,
        address signer,
        string memory domainVersion
    ) BaseHook(poolManager_) {
        // All four bindings are load-bearing and immutable/role-seeding; a zero here would brick the adapter.
        // `poolManager` was set by the base constructor above; re-check it alongside the rest for defense.
        require(
            address(poolManager) != address(0) && registry_ != address(0) && admin != address(0) && signer != address(0),
            Errors.ZeroAddress()
        );
        require(bytes(domainVersion).length != 0, Errors.EmptyDomainVersion());
        DOMAIN_VERSION_HASH = keccak256(bytes(domainVersion));
        _registry = registry_;
        backendSigner = signer;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        // Hardened by default: an admin must explicitly allowlist a router before any JIT-consuming swap can
        // land. See `jitTriggerAllowlistEnabled`'s @dev for why this is a backstop, not the primary defense.
        jitTriggerAllowlistEnabled = true;
        emit Events.V4JitTriggerAllowlistEnabled(address(this), true);

        emit Events.V4SignerSet(address(this), address(0), signer);
    }

    // ============================================================
    // IVenueAdapter
    // ============================================================

    /// @inheritdoc IVenueAdapter
    /// @dev Constant true. The registry calls this at allowlist time to confirm the contract is a real adapter.
    function isVenueAdapter() external pure override returns (bool) {
        return true;
    }

    /// @inheritdoc IVenueAdapter
    /// @dev The registry this adapter binds to. The registry checks this equals itself before allowlisting, so
    ///      a foreign-bound adapter can never be trusted by a registry it does not name.
    function registry() external view override returns (address) {
        return _registry;
    }

    /// @inheritdoc IVenueAdapter
    /// @dev `HookReactive`: this venue is driven by the PoolManager mid-swap, not by an operator call.
    function triggerModel() external pure override returns (TriggerModel) {
        return TriggerModel.HookReactive;
    }

    /// @inheritdoc IVenueAdapter
    /// @dev `SettlementReported`: value PnL is attributed off-chain from the `V4SwapSettled` feed, not
    ///      priced on-chain.
    function valuationModel() external pure override returns (ValuationModel) {
        return ValuationModel.SettlementReported;
    }

    // ============================================================
    // IHooks: permissions
    // ============================================================

    /// @notice The V4 hook permission flags this adapter enables (only `beforeSwap` and `afterSwap`).
    /// @dev The single source of truth for this hook's permission set: `BaseHook`'s constructor reads it through
    ///      `Hooks.validateHookPermissions` to assert the mined address bits, and integrators read it to confirm
    ///      the hook only reacts to swaps. The deployed hook address is mined to encode exactly these flags in
    ///      its low bits, so this view and the deployed address always agree. `beforeSwap` and `afterSwap` are
    ///      enabled, plus `beforeSwapReturnDelta`, which is what lets `beforeSwap` charge the swapper-paid
    ///      protocol fee (`_chargeProtocolFee`). That permission was mined in ahead of need precisely because
    ///      it cannot be added later without a new hook address, an adapter redeploy, and new pools with
    ///      migrated liquidity: buying the option cost one mining run on a fresh deploy and nothing after,
    ///      whereas not buying it would have made a swapper-paid fee permanently expensive and left LPs
    ///      bearing it on V4 routes while takers bear it on Aqua routes - the same trade charging a different
    ///      party based on routing nobody sees.
    ///
    ///      The remaining `*ReturnDelta` flags are false. `afterSwapReturnDelta` in particular is off, which
    ///      is why the fee is charged in `beforeSwap` on the specified amount rather than on the realized
    ///      output. Apart from that fee the hook does not rewrite swaps: it injects and removes JIT liquidity
    ///      and settles the resulting net delta out of band.
    /// @return The `Hooks.Permissions` struct with `beforeSwap`, `afterSwap` and `beforeSwapReturnDelta` set
    ///         and all others false.
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ============================================================
    // IHooks: swap lifecycle (only beforeSwap/afterSwap are enabled)
    // ============================================================
    //
    // `BaseHook` defines the full `IHooks` surface: its external `beforeSwap`/`afterSwap` are `onlyPoolManager`
    // and forward to the internal `_beforeSwap`/`_afterSwap` hooks overridden below; every other callback
    // (init / add-liquidity / remove-liquidity / donate) is left at its base default, which reverts
    // `HookNotImplemented`. Those permission bits are all false in `getHookPermissions`, so the PoolManager
    // never routes them, and keeping their bodies in the out-of-scope base drops them from the audited surface.

    /// @notice Inject signed JIT liquidity before a swap executes, and charge the protocol fee if one is armed.
    /// @dev A swap that carries no valid Aqua0 payload passes straight through: `_addVirtualLiquidity` returns
    ///      false without injecting, and this becomes a no-op returning a ZERO delta. The fee is deliberately
    ///      gated on that same boolean: a pass-through swap gets no Aqua0 liquidity, so it must not be charged
    ///      an Aqua0 fee. `BaseHook`'s `onlyPoolManager` gate on the external entry guarantees a genuine
    ///      mid-unlock context; `nonReentrant` here matches the prior direct-`IHooks` guard.
    ///
    ///      When the seam is disarmed (the default) this returns `ZERO_DELTA` and the trader's amounts are
    ///      untouched, exactly as before the seam existed.
    /// @param sender   The address that initiated the swap on the PoolManager (the router), used for the
    ///                 optional router allowlist gate.
    /// @param key      The pool being swapped.
    /// @param params   The swap parameters, matched byte-for-byte against the signed payload.
    /// @param hookData The trader-supplied blob; when prefixed with `AQUA0_MAGIC` it carries the signed JIT
    ///                 payload and ranges, otherwise it is ignored.
    /// @return The `beforeSwap` function selector confirming the callback.
    /// @return The protocol-fee before-swap delta, or ZERO when no fee is armed for this swap.
    /// @return A zero LP-fee override (this hook does not change the pool fee).
    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        internal
        override
        nonReentrant
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        // Only a swap that actually consumed an Aqua0 payload is charged; everything else returns ZERO_DELTA.
        BeforeSwapDelta feeDelta = _addVirtualLiquidity(key, sender, params, hookData)
            ? _chargeProtocolFee(key, params)
            : BeforeSwapDeltaLibrary.ZERO_DELTA;
        // Selector confirms the callback; the third return is 0, no LP-fee override (the pool's own Uniswap
        // fee is never rewritten by this hook - the protocol fee above is a separate, additive charge).
        return (IHooks.beforeSwap.selector, feeDelta, 0);
    }

    /// @notice Remove the injected JIT liquidity, settle the swap-induced net currency deltas per class, then
    ///         pay out any protocol fee this swap was charged.
    /// @dev Symmetric to `_beforeSwap`: if this pool had ranges injected in this unlock, remove them and settle
    ///      the resulting net delta out of each currency's vault; otherwise do nothing. Settlement is skipped
    ///      unless removal actually found ranges, so a pass-through (non-JIT) swap settles nothing. The
    ///      `afterSwapReturnDelta` permission is off, so the returned `int128` delta is always zero.
    ///
    ///      ORDER IS LOAD-BEARING; DO NOT MOVE `_takeProtocolFee` ABOVE `_settleVirtualLiquidityDeltas`.
    ///      `_settleVirtualLiquidityDeltas` derives everything it settles from this hook's OWN net
    ///      `currencyDelta`, and `poolManager.take` moves that number one-for-one. The fee must therefore be
    ///      invisible to it, and it is - for two reinforcing reasons:
    ///
    ///        1. v4-core credits a hook's `beforeSwapReturnDelta` to the hook's delta account in
    ///           `PoolManager.swap` only AFTER `hooks.afterSwap(...)` returns. So while we are inside this
    ///           callback the fee credit has not landed, and the delta we read is the pure LP delta.
    ///        2. The fee is taken only after settlement has already zeroed both legs.
    ///
    ///      Take the fee any earlier and the settle path reads a delta already short by the fee and settles
    ///      the LP against that smaller number - the fee comes out of the LP's proceeds while every line
    ///      still reads as though the swapper paid it.
    ///
    ///      As the code stands that mistake happens to fail LOUDLY, and it is worth being precise about why,
    ///      because the loudness is NOT a property of the fee code: it belongs to `_settleSwap`, which takes
    ///      the hook's ENTIRE remaining delta. A fee skimmed earlier therefore leaves the late-arriving
    ///      before-swap credit unclaimed at the end of the unlock, and v4-core reverts `CurrencyNotSettled`
    ///      (verified by moving this call above the settle and re-running the fork suite). That backstop
    ///      disappears the moment settlement takes a COMPUTED amount rather than the whole delta - at which
    ///      point the identical mistake shorts the LP with no revert, no change in `amountOut`, and the
    ///      vault's credited balance as the only observable. `test/fork/V4ProtocolFee.fork.t.sol` therefore
    ///      asserts the vault movement and the recipient balance independently instead of settling for "the
    ///      fee arrived", so the invariant stays pinned by intent rather than by a coincidence of today's
    ///      settle implementation.
    /// @param key    The pool being swapped.
    /// @param params The ORIGINAL swap parameters (v4-core passes the pre-hook `params` here, not the
    ///               fee-adjusted amount), used to name the currency the fee was charged in.
    /// @return The `afterSwap` function selector confirming the callback.
    /// @return A zero hook delta (the `afterSwapReturnDelta` permission is off, so no delta is returned).
    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta, bytes calldata)
        internal
        override
        nonReentrant
        returns (bytes4, int128)
    {
        if (_removeVirtualLiquidity(key)) {
            _settleVirtualLiquidityDeltas(key);
            _takeProtocolFee(key, params);
        }
        return (IHooks.afterSwap.selector, 0);
    }

    // ============================================================
    // Off-chain pre-flight
    // ============================================================

    /// @notice Recover the signer of a JIT payload without any state change; a read-only pre-flight the
    ///         backend can call to confirm a payload it just signed will recover to `backendSigner` on chain.
    /// @dev Recovers over the same digest `beforeSwap` uses, so a `recovered == backendSigner` result here is
    ///      a faithful dry run of the on-chain check. It does NOT consume the nonce or check the deadline, so
    ///      it is not proof the swap will land, only that the signature binds these params + ranges.
    /// @param encodedPayload `abi.encode(V4Types.JITPayload)`, the same blob passed in `hookData`.
    /// @param ranges         The JIT ranges; their `keccak256(abi.encode(ranges))` is bound into the digest.
    /// @return swapId    The payload's swap id.
    /// @return classId   The consent class the payload attributes the swap to.
    /// @return recovered The address recovered from the signature (compare to `backendSigner` off chain).
    function verifyJIT(bytes calldata encodedPayload, V4Types.V4Range[] calldata ranges)
        public
        view
        returns (bytes32 swapId, uint256 classId, address recovered)
    {
        V4Types.JITPayload memory p = abi.decode(encodedPayload, (V4Types.JITPayload));
        // Rebuild the exact digest `_verifyAndRecordSwap` recovers over, then recover the signer. Pure read:
        // no nonce burn, no deadline check.
        bytes32 digest = _buildDigest(p, keccak256(abi.encode(ranges)));
        return (p.swapId, p.classId, ECDSA.recover(digest, p.signature));
    }

    // ============================================================
    // Admin
    // ============================================================

    /// @notice Arm a pool for Aqua0 JIT (permissionless). Both pool tokens MUST already have a registry vault,
    ///         so the `afterSwap` net settlement can always route each currency home to its own vault, and the
    ///         caller becomes the pool's JIT registrant (the account allowed to `removeJITPosition` it).
    /// @dev Permissionless by design: arming is INERT. Arming alone injects nothing and moves no capital. The
    ///      hot path only reads `exists`/`active` here as an enablement gate; the injected liquidity comes from
    ///      the BACKEND-SIGNED payload ranges (`_verifyAndRecordSwap`), not this stored config, and settlement
    ///      additionally requires the class strategist's `approveClassForPool` consent, committed LP backing on
    ///      the vault, and passes the per-vault outflow meter. The stored `tickLower/tickUpper/token0/token1` are
    ///      validated here but never read on the hot path, so a permissionless arm cannot inject a griefing
    ///      range or mis-route settlement. Both tokens must be vaulted, so arming is confined to pools over the
    ///      protocol's own vaulted assets. Reverts on a second registration for the same pool (`exists`); update
    ///      is an explicit remove then re-add. `tickLower < tickUpper` and non-zero tokens are enforced here so
    ///      the hot path never has to. The pool id is derived from `key`, so the caller cannot arm a mismatched
    ///      id. First-arm-wins: whoever arms first is recorded as `jitRegistrant[pid]`.
    /// @param key       The pool key; `token0`/`token1` are snapshotted from its currencies.
    /// @param tickLower Lower tick bound of the JIT range (strictly below `tickUpper`).
    /// @param tickUpper Upper tick bound of the JIT range.
    function setJITPosition(PoolKey calldata key, int24 tickLower, int24 tickUpper) external {
        require(tickLower < tickUpper, Errors.InvalidTickRange(tickLower, tickUpper));
        PoolId pid = key.toId();
        require(!jitPositions[pid].exists, Errors.JitPositionAlreadyExists()); // no silent overwrite
        address t0 = Currency.unwrap(key.currency0);
        address t1 = Currency.unwrap(key.currency1);
        require(t0 != address(0) && t1 != address(0), Errors.ZeroAddress());
        // Both tokens must be vaulted at registration; the hot-path settle then never has to handle a
        // vault-less currency (its only failure mode there would be stranded principal).
        require(IVaultRegistry(_registry).vaultForAsset(t0) != address(0), Errors.TokenHasNoVault(t0));
        require(IVaultRegistry(_registry).vaultForAsset(t1) != address(0), Errors.TokenHasNoVault(t1));

        // `exists` and `active` both start true: a freshly registered position is armed. `token0`/`token1` are
        // snapshotted here so the settle path reads them from storage, not from a caller-supplied key.
        jitPositions[pid] = V4Types.JITPositionInfo({
            exists: true,
            active: true,
            tickLower: tickLower,
            tickUpper: tickUpper,
            token0: t0,
            token1: t1
        });
        // Record the arming account so `removeJITPosition` can be self-gated to it; a second arbitrary caller
        // can neither overwrite this armed pool (reverts above) nor disarm it (registrant-gated remove).
        jitRegistrant[pid] = msg.sender;
        emit Events.V4JITPositionSet(PoolId.unwrap(pid), tickLower, tickUpper, t0, t1);
    }

    /// @notice Remove a pool's JIT arming so it stops receiving Aqua0 JIT liquidity. Self-service: only the
    ///         pool's JIT registrant (the account that armed it) or an admin.
    /// @dev Gated to the registrant (or an admin janitor) so a second arbitrary caller cannot disarm a pool a
    ///      strategist relies on. Removal touches no capital: the hook holds nothing between swaps, so the only
    ///      effect is that future swaps route without injected liquidity, and it is fully recoverable (anyone may
    ///      re-arm the deleted pool via `setJITPosition`, becoming the new registrant). Reverts `JitPositionUnknown`
    ///      for an unarmed pool and `NotJitRegistrant` for any other caller.
    /// @param pid The pool id to remove (must currently exist).
    function removeJITPosition(PoolId pid) external {
        require(jitPositions[pid].exists, Errors.JitPositionUnknown());
        require(
            msg.sender == jitRegistrant[pid] || hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
            Errors.NotJitRegistrant(msg.sender)
        );
        delete jitPositions[pid]; // clears `exists`, so future swaps on this pool are treated as pass-through
        delete jitRegistrant[pid]; // release the pool so it can be re-armed by anyone
        emit Events.V4JITPositionRemoved(PoolId.unwrap(pid));
    }

    /// @notice The class's strategist approves `classId` to settle against `key`'s pool. Required before
    ///         `_verifyAndRecordSwap` accepts any swap attributed to `(pool, classId)`.
    /// @dev Resolves the strategist from BOTH the pool's currencies' vaults and requires them to agree
    ///      (mirrors `AquaAdapter._commitShipTokens`'s cross-vault check - a class is one consent unit).
    ///      `SignatureChecker` accepts an ERC-1271 smart-wallet strategist as well as an EOA. The sequential
    ///      per-strategist nonce is a SEPARATE namespace from the backend signer's per-swap `usedNonces`.
    /// @param key      The pool the strategist is approving `classId` for.
    /// @param classId  The consent class being approved.
    /// @param nonce    The strategist's current sequential nonce.
    /// @param deadline Unix timestamp after which this approval signature is rejected.
    /// @param strategistSig The class strategist's EIP-712 signature over `ClassApproval(..., approved: true, ...)`.
    function approveClassForPool(
        PoolKey calldata key,
        uint256 classId,
        uint256 nonce,
        uint256 deadline,
        bytes calldata strategistSig
    ) external {
        _setClassApproval(key, classId, true, nonce, deadline, strategistSig);
    }

    /// @notice The class's strategist revokes a previously granted approval. Symmetric with
    ///         `approveClassForPool`: same struct shape with `approved: false`, so a captured approval
    ///         signature can never be replayed to mean a revoke, or vice versa.
    /// @param key      The pool the strategist is revoking `classId` for.
    /// @param classId  The consent class being revoked.
    /// @param nonce    The strategist's current sequential nonce.
    /// @param deadline Unix timestamp after which this revoke signature is rejected.
    /// @param strategistSig The class strategist's EIP-712 signature over `ClassApproval(..., approved: false, ...)`.
    function revokeClassForPool(
        PoolKey calldata key,
        uint256 classId,
        uint256 nonce,
        uint256 deadline,
        bytes calldata strategistSig
    ) external {
        _setClassApproval(key, classId, false, nonce, deadline, strategistSig);
    }

    /// @dev Shared body for `approveClassForPool` / `revokeClassForPool`: resolve the class strategist from both
    ///      the pool's currencies' vaults (they must agree), verify the strategist's EIP-712 signature over the
    ///      `ClassApproval` struct with `approved` bound in, set the flag, and emit the matching event. `approved`
    ///      is part of the signed struct, so a captured approval signature can never be replayed to mean a revoke
    ///      or vice versa. Behind two thin external wrappers, so the ABI + signed typehash are unchanged.
    /// @param key      The pool the strategist is (un)approving `classId` for.
    /// @param classId  The consent class being (un)approved.
    /// @param approved True to approve, false to revoke.
    /// @param nonce    The strategist's current sequential nonce.
    /// @param deadline Unix timestamp after which this signature is rejected.
    /// @param strategistSig The class strategist's EIP-712 signature over `ClassApproval(..., approved, ...)`.
    function _setClassApproval(
        PoolKey calldata key,
        uint256 classId,
        bool approved,
        uint256 nonce,
        uint256 deadline,
        bytes calldata strategistSig
    ) private {
        PoolId pid = key.toId();
        address strategist = _resolveClassStrategist(key, classId);
        bytes32 structHash =
            keccak256(abi.encode(CLASS_APPROVAL_TYPEHASH, PoolId.unwrap(pid), classId, approved, nonce, deadline));
        _verifyStrategist(strategist, structHash, nonce, deadline, strategistSig);
        classApprovedForPool[pid][classId] = approved;
        if (approved) {
            emit Events.V4ClassApprovedForPool(PoolId.unwrap(pid), classId, strategist);
        } else {
            emit Events.V4ClassRevokedForPool(PoolId.unwrap(pid), classId, strategist);
        }
    }

    /// @dev Resolve `classId`'s strategist from BOTH of `key`'s currencies' vaults, requiring them to agree
    ///      (a class is one consent unit spanning two per-asset vaults, same invariant Aqua enforces at ship
    ///      time). Reverts `ClassHasNoStrategist` if either vault has no strategist registered for the
    ///      class, or `ClassStrategistMismatch` if they disagree.
    /// @param key The pool whose two currency vaults are consulted for the class strategist.
    /// @param classId The class (strategy) id whose strategist is resolved.
    /// @return strategist The strategist both currency vaults agree on for `classId`.
    function _resolveClassStrategist(PoolKey calldata key, uint256 classId)
        internal
        view
        returns (address strategist)
    {
        address vault0 = IVaultRegistry(_registry).vaultForAsset(Currency.unwrap(key.currency0));
        address vault1 = IVaultRegistry(_registry).vaultForAsset(Currency.unwrap(key.currency1));
        address strat0 = IAssetVault(vault0).classStrategist(classId);
        address strat1 = IAssetVault(vault1).classStrategist(classId);
        require(strat0 != address(0), Errors.ClassHasNoStrategist(classId));
        require(strat0 == strat1, Errors.ClassStrategistMismatch(classId));
        strategist = strat0;
    }

    /// @dev Sequential-nonce, deadline-bound, ERC-1271-aware strategist signature check. Mirrors
    ///      `AquaAdapter._verifyStrategist` verbatim so the strategist consent model is identical across
    ///      both venues.
    /// @param strategist The class strategist expected to have signed; also the ERC-1271 signer candidate.
    /// @param structHash The EIP-712 struct hash of the payload being authorized.
    /// @param nonce The caller-supplied sequential nonce; must equal the strategist's current nonce.
    /// @param deadline The unix timestamp after which the signature is rejected.
    /// @param sig The strategist's EIP-712 signature (EOA or ERC-1271) over the domain-bound digest.
    function _verifyStrategist(
        address strategist,
        bytes32 structHash,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) internal {
        require(block.timestamp <= deadline, Errors.SignatureExpired(deadline, block.timestamp));
        uint256 expected = strategistNonces[strategist];
        require(nonce == expected, Errors.StrategistNonceMismatch(strategist, nonce, expected));
        strategistNonces[strategist] = expected + 1;
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        require(SignatureChecker.isValidSignatureNow(strategist, digest, sig), Errors.NotStrategist(strategist));
    }

    /// @notice Pause or resume JIT injection for one pool without discarding its configuration.
    /// @dev Authorization is split by DIRECTION, mirroring the venue-wide `pause()` (guardian) / `unpause()`
    ///      (admin) split: pausing ONE pool's injection (`active == false`) is a protective circuit-breaker and
    ///      must be as fast as the venue-wide guardian pause, so the guardian OR the admin may do it; RE-ARMING
    ///      (`active == true`) is an unpause and stays admin-only (timelocked), so the fast responder can stop
    ///      one pool's bleeding but never silently re-enable a position it just distrusted. Without this split
    ///      the guardian's only surgical lever during an incident was the blunt venue-wide `pause()`, which
    ///      kills JIT for every healthy pool too. Re-validates the tick bounds and non-zero tokens on the
    ///      pause->active transition, so a config that somehow became degenerate cannot be re-armed.
    ///      `_addVirtualLiquidity` refuses to inject into a paused position, so a paused pool swaps unassisted.
    /// @param pid    The configured pool id.
    /// @param active True to arm injection (admin-only), false to pause it (guardian or admin).
    function pauseJITPosition(PoolId pid, bool active) external {
        if (active) {
            // Re-arm is an unpause: admin-only, so a guardian can never silently re-enable a distrusted pool.
            _checkRole(DEFAULT_ADMIN_ROLE);
        } else {
            // Protective single-pool pause: the pause-only guardian must be able to stop the bleeding fast.
            require(
                hasRole(Roles.GUARDIAN_ROLE, msg.sender) || hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
                Errors.NotAdminOrGuardian(msg.sender)
            );
        }
        V4Types.JITPositionInfo storage pos = jitPositions[pid];
        require(pos.exists, Errors.JitPositionUnknown());
        // Re-validate only when re-arming (paused -> active): a degenerate stored config must never go live.
        if (active && !pos.active) {
            require(pos.tickLower < pos.tickUpper, Errors.InvalidTickRange(pos.tickLower, pos.tickUpper));
            require(pos.token0 != address(0) && pos.token1 != address(0), Errors.ZeroAddress());
        }
        pos.active = active;
        emit Events.V4JITPositionPaused(PoolId.unwrap(pid), active);
    }

    /// @notice Rotate the backend signer key. Gated to `DEFAULT_ADMIN_ROLE`, which in production is the
    ///         timelocked multisig, so this rotation is TIMELOCKED (it is NOT an instant lever). Until the
    ///         timelock elapses, the immediate containment is the guardian pause. The per-vault outflow meter
    ///         bounds sustained net one-way drain per window, but it constrains a leak ONLY when its limit is
    ///         sized against what the vault actually holds: a limit far above the vault's balance cannot be
    ///         reached, so treat it as a second lever only after confirming the deployed limit is proportionate.
    /// @dev Every in-flight payload signed by the OLD key stops verifying once this executes, which is the
    ///      intended effect of a leak response. The new signer is non-zero. Whether to add a dedicated,
    ///      non-timelocked fast-rotation role for the hot key is a pending owner decision; today the gate is
    ///      the standard admin/timelock and the containment story above is what covers the rotation window.
    /// @param signer The new backend EIP-712 signer (non-zero).
    function setBackendSigner(address signer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(signer != address(0), Errors.ZeroAddress());
        address old = backendSigner;
        backendSigner = signer;
        // Emit both old and new so an indexer can track the rotation and flag payloads still signed by `old`.
        emit Events.V4SignerSet(address(this), old, signer);
    }

    /// @notice Guardian circuit-breaker: pause JIT injection instantly (for example on a suspected bad
    ///         signer). A paused adapter skips injection so swaps still execute, just without Aqua0 JIT
    ///         liquidity. The pause-only guardian holds the fastest lever against a signer leak.
    /// @dev Deliberately split from `unpause`: the least-privileged guardian can stop the bleeding but cannot
    ///      resume, so re-arming always requires an admin review.
    function pause() external onlyRole(Roles.GUARDIAN_ROLE) {
        _pause();
    }

    /// @notice Resume JIT injection after review. Admin-only (the guardian can pause but never unpause).
    /// @dev Splitting pause (guardian) from unpause (admin) means the fast responder cannot also silently
    ///      re-enable a signer it just distrusted; re-arming is always a deliberate admin action.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Enable or disable the router allowlist gate for JIT triggering.
    /// @dev When enabled, `beforeSwap` requires the swap's `sender` (the router) to be allowlisted before it
    ///      will consume a JIT payload. ON by default (set in the constructor), so a fresh deployment starts
    ///      closed and an admin must allowlist a router before any JIT-consuming swap can land. It remains a
    ///      defense-in-depth knob rather than the primary control: the per-payload `executor` binding is what
    ///      ties a payload to one triggering router.
    /// @param enabled True to enforce the allowlist, false to allow any router to trigger JIT.
    function setJitTriggerAllowlistEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        jitTriggerAllowlistEnabled = enabled;
        emit Events.V4JitTriggerAllowlistEnabled(address(this), enabled);
    }

    /// @notice Add or remove a router from the JIT-trigger allowlist.
    /// @dev Only consulted while `jitTriggerAllowlistEnabled` is true.
    /// @param router  The router address (non-zero).
    /// @param allowed True to allowlist it, false to remove it.
    function setJitTriggerRouterAllowed(address router, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(router != address(0), Errors.ZeroAddress());
        jitTriggerRouterAllowed[router] = allowed;
        emit Events.V4JitTriggerRouterAllowed(address(this), router, allowed);
    }

    /// @notice Configure the protocol-fee seam: the rate and the recipient it accrues to.
    /// @dev Both are set in ONE call on purpose. Separate setters would admit a window where a live rate has
    ///      no recipient (or a stale one), and a fee charged in that window would have to be either burned to
    ///      the zero address or paid to the wrong account. Setting them together makes "armed" a single
    ///      atomic state.
    ///
    ///      Passing `recipient = address(0)` with `feePpb = 0` returns the adapter to its INERT default. Any
    ///      other combination with a zero recipient is refused, so a rate can never be live without somewhere
    ///      to send it.
    ///
    ///      Gated to `DEFAULT_ADMIN_ROLE`, which in production is the timelocked multisig: unlike the hot
    ///      `backendSigner`, this seam moves value to a named account, so arming it is a deliberate,
    ///      reviewable governance action rather than something a per-swap signature can decide.
    /// @param recipient The account fees accrue to; zero only when `feePpb` is also zero.
    /// @param feePpb    The rate in PARTS PER BILLION, bounded by `MAX_PROTOCOL_FEE_PPB`.
    function setProtocolFee(address recipient, uint32 feePpb) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(feePpb <= MAX_PROTOCOL_FEE_PPB, Errors.FeeRateOutOfRange(feePpb, MAX_PROTOCOL_FEE_PPB));
        // A non-zero rate with nowhere to send it is refused; (0, 0) is the inert default and is allowed.
        require(recipient != address(0) || feePpb == 0, Errors.ZeroAddress());
        protocolFeeRecipient = recipient;
        protocolFeePpb = feePpb;
        emit Events.V4ProtocolFeeSet(address(this), recipient, feePpb);
    }

    /// @notice Override the protocol-fee rate for ONE pool, replacing the global rate for that pool only.
    /// @dev Passing `feePpb = 0` is a DELIBERATE WAIVER, not a reset: the pool is recorded as having an
    ///      override worth zero and is charged nothing. That distinction is the entire point of this setter
    ///      existing separately from `clearPoolProtocolFee` - with one combined setter, "waive this pair" and
    ///      "stop overriding this pair" would be the same call with the same argument, and an operator
    ///      intending the former would silently get the latter and keep being charged the global rate. Use
    ///      `clearPoolProtocolFee` to fall back to the global rate; use this with 0 to charge nothing.
    ///
    ///      Bounded by the SAME `MAX_PROTOCOL_FEE_PPB` ceiling as the global setter. A per-pool path that
    ///      skipped it would be a hole that reads as closed because the global path is bounded.
    ///
    ///      Takes the `PoolKey` rather than a raw `PoolId` so the id is DERIVED, exactly as `setJITPosition`
    ///      does: an operator cannot waive or raise the fee on the wrong pool by mistyping 32 bytes.
    /// @param key    The pool this override applies to; its id is derived here.
    /// @param feePpb The pool's rate in PARTS PER BILLION (1e9 == 100%), bounded by `MAX_PROTOCOL_FEE_PPB`.
    ///               Zero means this pool is charged nothing.
    function setPoolProtocolFee(PoolKey calldata key, uint32 feePpb) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(feePpb <= MAX_PROTOCOL_FEE_PPB, Errors.FeeRateOutOfRange(feePpb, MAX_PROTOCOL_FEE_PPB));
        PoolId pid = key.toId();
        poolProtocolFee[pid] = V4Types.PoolProtocolFee({ set: true, ppb: feePpb });
        emit Events.V4PoolProtocolFeeSet(address(this), PoolId.unwrap(pid), feePpb);
    }

    /// @notice Drop a pool's override so it falls back to the global `protocolFeePpb` again.
    /// @dev The inverse of `setPoolProtocolFee`, and NOT the same as setting the override to zero: this
    ///      restores the global rate, whereas a zero override charges nothing.
    /// @param key The pool whose override is removed; its id is derived here.
    function clearPoolProtocolFee(PoolKey calldata key) external onlyRole(DEFAULT_ADMIN_ROLE) {
        PoolId pid = key.toId();
        delete poolProtocolFee[pid];
        emit Events.V4PoolProtocolFeeCleared(address(this), PoolId.unwrap(pid));
    }

    /// @notice The rate a swap on `key` would actually be charged right now, override and inert gate included.
    /// @dev Read this rather than `poolProtocolFee`/`protocolFeePpb` when confirming a configuration change
    ///      landed. The two raw reads cannot answer the question on their own - a zero override and an absent
    ///      override look similar in the getter but resolve to opposite rates - and this returns the number
    ///      the hot path will use, so "did my waiver take effect" has a direct answer.
    /// @param key The pool being asked about.
    /// @return The effective rate in PARTS PER BILLION; zero when the pool is free or the seam is disarmed.
    function effectiveProtocolFeePpb(PoolKey calldata key) external view returns (uint32) {
        if (protocolFeeRecipient == address(0)) return 0; // disarmed: overrides cannot route around this
        return _resolveProtocolFeePpb(key.toId());
    }

    /// @notice Sweep a token that has NEVER had a registry vault out of the adapter (settlement dust, an
    ///         airdrop). A vault-backed token can never leave this way; it only moves through the settle
    ///         seam to its own vault, so no admin key can divert vault capital.
    /// @dev Keyed on the PERMANENT `isVaultedAsset` flag, not the clearable `vaultForAsset` edge: otherwise a
    ///      `deregister` would re-classify a live vault's asset as sweepable dust and open an exfiltration
    ///      path. The adapter is non-custodial at rest, so any balance here is genuinely stray.
    /// @param token  The token to sweep (must NEVER have been a vaulted asset).
    /// @param to     Recipient of the swept tokens (non-zero).
    /// @param amount Amount to sweep (> 0).
    function rescueUnvaultedToken(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        require(to != address(0), Errors.ZeroAddress());
        require(amount > 0, Errors.ZeroAmount());
        // Hard gate: a token that is (or ever was) a vaulted asset can NEVER exit here. This is the line that
        // stops an admin key from diverting vault-backed capital under the guise of a dust rescue.
        require(
            !IVaultRegistry(_registry).isVaultedAsset(token),
            Errors.TokenHasVault(token, IVaultRegistry(_registry).vaultForAsset(token))
        );
        IERC20(token).safeTransfer(to, amount);
        emit Events.V4TokensRescued(address(this), token, to, amount);
    }

    // ============================================================
    // Internals; JIT inject / remove / settle
    //
    // The full JIT life of a swap: `beforeSwap` -> `_addVirtualLiquidity` (verify, inject, record transiently)
    // and then `afterSwap` -> `_removeVirtualLiquidity` (undo the injection) -> `_settleVirtualLiquidityDeltas`
    // (settle the net delta per vault). All cross-call state lives in transient storage keyed by pool id and is
    // cleared before the unlock ends, so nothing survives the swap.
    // ============================================================

    /// @dev Verify and inject the signed JIT ranges, recording range/swap/class data transiently per pool. All
    ///      early returns are intentional no-ops that leave the swap to proceed WITHOUT Aqua0 liquidity (never
    ///      a revert): a non-Aqua0 swap must pass through untouched. Only genuine authorization failures
    ///      (bad pool id, unknown/paused position, bad signature, spent nonce) revert.
    /// @param key      The pool being swapped.
    /// @param sender   The router that triggered the swap (checked against the allowlist when enabled).
    /// @param params   The swap parameters, matched against the signed payload in `_verifyAndRecordSwap`.
    /// @param hookData The trader blob; must start with `AQUA0_MAGIC` to be treated as an Aqua0 payload.
    /// @return injected True only if this swap consumed an Aqua0 payload and liquidity was injected. Every
    ///                  pass-through path returns false EXPLICITLY (rather than falling out of a named return)
    ///                  because this boolean is what decides whether a protocol fee is charged: a swap that
    ///                  received no Aqua0 liquidity must never be charged for it.
    function _addVirtualLiquidity(
        PoolKey calldata key,
        address sender,
        SwapParams calldata params,
        bytes calldata hookData
    ) internal returns (bool injected) {
        if (paused()) return false; // guardian circuit-breaker: skip JIT, let the swap proceed unassisted
        if (hookData.length < 32) return false; // too short to even carry the magic word
        bytes32 magic;
        assembly ("memory-safe") {
            magic := calldataload(hookData.offset) // read the first word without copying the whole blob
        }
        if (magic != AQUA0_MAGIC) return false; // not an Aqua0 payload: leave the swap alone

        // Optional router gate: when enforced, only an allowlisted router may consume a JIT payload.
        if (jitTriggerAllowlistEnabled) {
            require(jitTriggerRouterAllowed[sender], Errors.RouterNotAllowed());
        }

        // Layout: (magic, encodedPayload, ranges, trailing). The trailing field is reserved and ignored.
        (, bytes memory encodedPayload, V4Types.V4Range[] memory ranges,) =
            abi.decode(hookData, (bytes32, bytes, V4Types.V4Range[], bytes));
        if (encodedPayload.length == 0 || ranges.length == 0) return false; // nothing to inject

        V4Types.JITPayload memory p = abi.decode(encodedPayload, (V4Types.JITPayload));

        // Bind the payload to THIS pool before any signature work: a payload signed for another pool cannot be
        // replayed here (the pool id is also inside the signed digest, so this is defense-in-depth).
        PoolId pid = key.toId();
        require(p.poolId == PoolId.unwrap(pid), Errors.InvalidSignature());

        V4Types.JITPositionInfo storage pos = jitPositions[pid];
        require(pos.exists, Errors.JitPositionUnknown());
        require(pos.active, Errors.JitPositionPaused());

        _verifyAndRecordSwap(key, sender, params, p, ranges, pid);
        _injectRanges(key, pid, ranges);
        injected = true;
    }

    /// @dev Bind a JIT authorization to THIS swap, verify + replay-protect it adapter-side, and record
    ///      swapId + classId + rangeCount transiently (keyed by pool) for `afterSwap`. Extracted verbatim
    ///      from `_addVirtualLiquidity` to keep that frame shallow enough for coverage instrumentation;
    ///      identical checks, the same nonce write, and the same transient writes, in the same order.
    ///      The swap-match checks run BEFORE the nonce is consumed, so a mismatched swap reverts without
    ///      burning the legitimate trader's one-shot payload.
    /// @param key    The pool being swapped.
    /// @param sender The router that triggered this swap on the PoolManager; must equal the payload's signed
    ///               `executor`, so a payload observed in the mempool cannot be replayed through a different
    ///               router ahead of the intended trader. It binds the ROUTER only; see the scope note at the
    ///               check itself for what it does not bind.
    /// @param params The live swap parameters; each must equal the signed value or the payload is not for this
    ///               swap (a signer cannot be tricked into liquidity for a different trade).
    /// @param p      The decoded, signed JIT payload.
    /// @param ranges The signed ranges; their hash is bound into the digest, so ranges cannot be substituted.
    /// @param pid    The pool id, used as the transient-storage key namespace.
    function _verifyAndRecordSwap(
        PoolKey calldata key,
        address sender,
        SwapParams calldata params,
        V4Types.JITPayload memory p,
        V4Types.V4Range[] memory ranges,
        PoolId pid
    ) internal {
        // The signed payload authorizes ONE specific trade. Reject any swap whose direction, amount, or price
        // limit differs from what the signer approved, BEFORE consuming the nonce (see the @dev note): the
        // signer must never end up providing liquidity for a swap it did not size.
        require(params.zeroForOne == p.zeroForOne, Errors.JitSwapMismatch());
        require(params.amountSpecified == p.amountSpecified, Errors.JitSwapMismatch());
        require(params.sqrtPriceLimitX96 == p.sqrtPriceLimitX96, Errors.JitSwapMismatch());

        // The signed payload also authorizes ONE specific triggering router. A front-runner who lifts a valid
        // signed payload from the mempool and replays the identical swap through a DIFFERENT router cannot
        // consume it: `sender` is the PoolManager caller, checked before the nonce is burned, so that attempt
        // reverts without griefing the intended trader's payload.
        //
        // SCOPE OF THIS BINDING. `sender` is the router contract, never the router's own caller, which the
        // hook cannot observe. Two callers of the SAME router are indistinguishable here, and no field in the
        // signed digest names the intended trader, so this check does not reserve the payload for them: a
        // second caller who resubmits the identical swap through the same router consumes it and takes the
        // fill. Binding the claimant needs a claimant in the signed struct, which is a wire change shared with
        // the backend signer.
        require(sender == p.executor, Errors.JitExecutorMismatch(sender, p.executor));

        // `backendSigner` (a hot, non-timelocked key) authorizes the swap MECHANICS per trade, but never
        // proved the class's OWNER consented to this pool at all. Require the strategist to have
        // pre-approved this exact (pool, classId) pairing, mirroring the consent Aqua enforces before a
        // class's capital ships. A leaked backendSigner can no
        // longer attribute settlement to a class its strategist never approved for this pool.
        require(classApprovedForPool[pid][p.classId], Errors.ClassNotApprovedForPool(PoolId.unwrap(pid), p.classId));

        // Adapter-side signature verification + replay protection (own per-adapter nonce namespace). No
        // operator sits in this mid-swap stack, so the signature IS the authorization.
        require(block.timestamp <= p.deadline, Errors.ExpiredDeadline(p.deadline, block.timestamp));
        bytes32 digest = _buildDigest(p, keccak256(abi.encode(ranges)));
        require(ECDSA.recover(digest, p.signature) == backendSigner, Errors.InvalidSignature());
        require(!usedNonces[p.nonce], Errors.NonceUsed(p.nonce)); // one-shot: reject a replayed payload
        usedNonces[p.nonce] = true;

        uint256 rangeCount = ranges.length;
        require(rangeCount <= MAX_JIT_RANGES, Errors.TooManyRanges(rangeCount, MAX_JIT_RANGES));

        // Record swapId + classId + rangeCount transiently, keyed by pool, for afterSwap to read back. Copying
        // to locals first keeps the assembly block memory-safe (no struct field access inside it).
        bytes32 swapIdVal = p.swapId;
        uint256 classIdVal = p.classId;
        bytes32 ptrSwapId = keccak256(abi.encode(pid, TSLOT_LABEL_SWAP_ID));
        bytes32 ptrClassId = keccak256(abi.encode(pid, TSLOT_LABEL_CLASS_ID));
        bytes32 ptrRangeCount = keccak256(abi.encode(pid, TSLOT_LABEL_RANGE_COUNT));
        // Persist for `afterSwap` within this unlock only. Cleared there (rangeCount on removal, swap/class on
        // settle), so a later same-pool swap in the same unlock cannot read stale attribution.
        assembly ("memory-safe") {
            tstore(ptrSwapId, swapIdVal)
            tstore(ptrClassId, classIdVal)
            tstore(ptrRangeCount, rangeCount)
        }
    }

    /// @dev Inject each signed JIT range via `modifyLiquidity` and transiently record it (keyed by pool)
    ///      for removal in `afterSwap`. Extracted verbatim from `_addVirtualLiquidity`'s loop to keep that
    ///      frame shallow enough for coverage instrumentation; same external calls, same transient
    ///      writes, same order. The caller has already bounded `ranges.length` by `MAX_JIT_RANGES`.
    /// @param key    The pool to add liquidity to.
    /// @param pid    The pool id, the transient-storage key namespace.
    /// @param ranges The signed ranges to inject; each is also stored transiently so `afterSwap` removes the
    ///               exact same tick band and liquidity it added.
    function _injectRanges(PoolKey calldata key, PoolId pid, V4Types.V4Range[] memory ranges) internal {
        uint256 rangeCount = ranges.length;
        for (uint256 i; i < rangeCount; ++i) {
            V4Types.V4Range memory r = ranges[i];
            poolManager.modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: r.tickLower,
                    tickUpper: r.tickUpper,
                    liquidityDelta: int256(uint256(r.liquidity)),
                    salt: bytes32(0)
                }),
                ""
            );
            // Record this range's exact tick band and liquidity (indexed by `i`) so `afterSwap` removes the
            // identical position it just added, netting the injection to zero.
            bytes32 ptrLower = keccak256(abi.encode(pid, TSLOT_LABEL_TICK_LOWER, i));
            bytes32 ptrUpper = keccak256(abi.encode(pid, TSLOT_LABEL_TICK_UPPER, i));
            bytes32 ptrLiq = keccak256(abi.encode(pid, TSLOT_LABEL_LIQUIDITY, i));
            int256 tl = int256(r.tickLower);
            int256 tu = int256(r.tickUpper);
            uint256 lq = uint256(r.liquidity);
            assembly ("memory-safe") {
                tstore(ptrLower, tl)
                tstore(ptrUpper, tu)
                tstore(ptrLiq, lq)
            }
        }
    }

    /// @dev Remove all transiently-recorded JIT ranges for a pool, reversing exactly what `_injectRanges`
    ///      added. Returns whether this pool had any injection this unlock, which is what tells `afterSwap`
    ///      whether to settle.
    /// @param key The pool to remove liquidity from.
    /// @return hasJIT True if ranges were found and removed (settlement should run), false for a pass-through
    ///                swap that injected nothing.
    function _removeVirtualLiquidity(PoolKey calldata key) internal returns (bool hasJIT) {
        PoolId pid = key.toId();
        uint256 rangeCount;
        bytes32 ptrRangeCount = keccak256(abi.encode(pid, TSLOT_LABEL_RANGE_COUNT));
        // Read the count `beforeSwap` recorded for this pool (zero if this swap injected nothing).
        assembly ("memory-safe") {
            rangeCount := tload(ptrRangeCount)
        }
        if (rangeCount == 0) return false; // no injection this unlock: nothing to remove, nothing to settle

        for (uint256 i; i < rangeCount; ++i) {
            bytes32 ptrLower = keccak256(abi.encode(pid, TSLOT_LABEL_TICK_LOWER, i));
            bytes32 ptrUpper = keccak256(abi.encode(pid, TSLOT_LABEL_TICK_UPPER, i));
            bytes32 ptrLiq = keccak256(abi.encode(pid, TSLOT_LABEL_LIQUIDITY, i));
            int256 tl;
            int256 tu;
            uint256 lq;
            assembly ("memory-safe") {
                tl := tload(ptrLower)
                tu := tload(ptrUpper)
                lq := tload(ptrLiq)
            }
            // The value was written by `_injectRanges` from a uint128; re-assert the bound before negating so
            // `-int256(lq)` cannot overflow into a spurious positive add.
            require(lq <= type(uint128).max, Errors.LiquidityOverflow(lq));
            // Negative delta removes the exact band that was added, netting this pool's injected liquidity to
            // zero within the unlock.
            poolManager.modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: int24(tl),
                    tickUpper: int24(tu),
                    liquidityDelta: -int256(lq),
                    salt: bytes32(0)
                }),
                ""
            );
        }
        // Clear the transient range count so a SECOND same-pool swap in the SAME PoolManager unlock (a
        // split route / aggregator batch, whose beforeSwap wrote nothing) cannot re-read this swap's stale
        // rangeCount and try to remove an already-emptied position; which would underflow v4-core and
        // revert the whole batch. The per-range tick/liq slots are only ever read while rangeCount > 0, so
        // zeroing the count alone is sufficient.
        assembly ("memory-safe") {
            tstore(ptrRangeCount, 0)
        }
        return true;
    }

    /// @dev Settle the net currency deltas for a pool against each currency's vault, keyed by the class the
    ///      payload attributed the swap to. Runs only after `_removeVirtualLiquidity` confirmed this pool had
    ///      an injection this unlock, so `swapId`/`classId` are guaranteed present (asserted below).
    /// @param key The pool whose PoolManager deltas are being settled.
    function _settleVirtualLiquidityDeltas(PoolKey calldata key) internal {
        PoolId pid = key.toId();
        uint256 classId;
        bytes32 swapId;
        bytes32 ptrClassId = keccak256(abi.encode(pid, TSLOT_LABEL_CLASS_ID));
        bytes32 ptrSwapId = keccak256(abi.encode(pid, TSLOT_LABEL_SWAP_ID));
        // Read back the attribution this swap's `beforeSwap` wrote transiently.
        assembly ("memory-safe") {
            classId := tload(ptrClassId)
            swapId := tload(ptrSwapId)
        }
        // A present swap id is the proof `beforeSwap` ran and injected for THIS pool this unlock; its absence
        // means we are settling a swap we never authorized, which must not happen once removal returned true.
        require(swapId != bytes32(0), Errors.ActiveSwapIdMissing());

        // The hook's own net owed/owing per currency after the swap traded against the injected liquidity.
        // Negative = this hook owes the PoolManager (the OUT leg it must fund); positive = the PoolManager owes
        // the hook (the IN leg it collects).
        int256 delta0 = poolManager.currencyDelta(address(this), key.currency0);
        int256 delta1 = poolManager.currencyDelta(address(this), key.currency1);

        // A JIT swap moves BOTH currencies: one out (hook owes the PM, delta < 0), one in (PM owes the hook,
        // delta > 0). The out leg names WHO sold (the vault's `Alloc[]`); that allocation is threaded into the
        // in leg's `settleVenueCredit` so each sold committer's proceeds are attributed to them in the counter
        // vault (ownership-follows-sourcing).
        if (delta0 != 0 && delta1 != 0) {
            // Normal two-sided JIT swap. Whichever currency is negative is the OUT leg (funded from its vault);
            // the other is the IN leg (collected into its vault).
            // Opposite signs are what makes the casts below sound: the ternary tests ONE delta and casts the
            // OTHER straight to `uint256`, so a same-sign pair would wrap a negative into a ~1.16e77 amount
            // and hand it to a vault. Assert the shape here rather than rely on a downstream revert.
            require((delta0 < 0) != (delta1 < 0), Errors.JitDeltaSignMismatch(delta0, delta1));
            (Currency outC, uint256 outAmt, Currency inC, uint256 inAmt) = delta0 < 0
                ? (key.currency0, uint256(-delta0), key.currency1, uint256(delta1))
                : (key.currency1, uint256(-delta1), key.currency0, uint256(delta0));
            _settleSwap(classId, outC, outAmt, inC, inAmt);
        } else if (delta0 != 0) {
            // Only one currency moved: not the expected two-sided shape, so refuse rather than settle
            // unattributed (see `_settleSingle`).
            _settleSingle(key.currency0, delta0, classId);
        } else if (delta1 != 0) {
            _settleSingle(key.currency1, delta1, classId);
        }

        // The off-chain PnL feed: both signed deltas and the class/swap id, from which the backend attributes
        // value PnL. On-chain settlement above is delta-only; valuation is not computed here.
        emit Events.V4SwapSettled(
            address(this),
            classId,
            swapId,
            Currency.unwrap(key.currency0),
            delta0,
            Currency.unwrap(key.currency1),
            delta1
        );

        // Clear the transient swap/class markers so a later same-pool swap in this unlock cannot settle
        // against a stale swapId/classId (defense-in-depth alongside the rangeCount clear in removal).
        assembly ("memory-safe") {
            tstore(ptrSwapId, 0)
            tstore(ptrClassId, 0)
        }
    }

    /// @dev Settle a JIT swap's two legs: source the OUT currency from its vault (capturing the sourcing
    ///      allocation), then credit the IN currency to the SAME sold committers in the counter vault. The
    ///      reference price is the executed ratio `inAmt / outAmt` (in RAY): every unit of the input is credited
    ///      as the sold committers' proceeds, so the counter vault's `Σ proceeds == received` and conservation
    ///      holds. (Mid-vs-executed fee segregation is a follow-on; here the LP keeps the full proceeds.)
    /// @param classId The consent class both legs settle against.
    /// @param outC    The currency owed to the PoolManager (funded from its vault).
    /// @param outAmt  Amount of `outC` owed (the vault's `settleVenueOut` debit; INV-GLOBAL bounds it to idle).
    /// @param inC     The currency the PoolManager owes the hook (collected into its vault).
    /// @param inAmt   Amount of `inC` collected and credited to the sold committers.
    function _settleSwap(uint256 classId, Currency outC, uint256 outAmt, Currency inC, uint256 inAmt) private {
        // Both currencies MUST resolve to a vault; a missing vault means the JIT position was registered
        // against an unvaulted token, which `setJITPosition` forbids, so this is a hard invariant re-check.
        address outVault = IVaultRegistry(_registry).vaultForAsset(Currency.unwrap(outC));
        require(outVault != address(0), Errors.TokenHasNoVault(Currency.unwrap(outC)));
        address inVault = IVaultRegistry(_registry).vaultForAsset(Currency.unwrap(inC));
        require(inVault != address(0), Errors.TokenHasNoVault(Currency.unwrap(inC)));

        // OUT leg: sync then have the vault push `outAmt` straight to the PoolManager and settle the debt. The
        // returned `Alloc[]` names WHICH committers sold, so their proceeds can be attributed on the IN leg.
        poolManager.sync(outC);
        Alloc[] memory alloc = IAssetVault(outVault).settleVenueOut(classId, address(poolManager), outAmt);
        poolManager.settle();

        // IN leg: pull `inAmt` from the PoolManager into the hook, approve the counter vault exactly that
        // much, and credit it to the SAME sold committers at the executed ratio (inAmt/outAmt in RAY), so
        // proceeds follow sourcing and per-vault conservation holds.
        poolManager.take(inC, address(this), inAmt);
        IERC20(Currency.unwrap(inC)).forceApprove(inVault, inAmt);
        uint256 refPriceRay = Math.mulDiv(inAmt, 1e27, outAmt);
        IAssetVault(inVault).settleVenueCredit(classId, inAmt, alloc, refPriceRay);
    }

    /// @dev Single-currency settle: the injected bands were never crossed, so only rounding residue is owed.
    ///
    ///      WHY THIS IS THE NORMAL SHAPE, NOT A DEGENERATE ONE. For a band that does not contain the current
    ///      tick, v4-core writes the OTHER currency's delta as a literal zero, and it rounds an ADD up and a
    ///      REMOVE down on the currency it does write. So an inject/remove pair over a band the swap never
    ///      reached nets a few wei OWED on one currency and exactly zero on the other, every time, with no
    ///      fee accrual to offset it. That residue is the LP's own rounding loss, it is bounded by
    ///      `MAX_JIT_ROUNDING_DUST`, and it is sourced from the same vault and the same seam the two-sided
    ///      path uses. There is no counter-credit because nothing came back in.
    ///
    ///      Anything outside that shape (owed to the hook rather than by it, or larger than the residue bound)
    ///      is not reachable from an inject/remove pair and carries no attribution, so it is refused.
    /// @param currency The lone currency that moved; also the vault the residue is sourced from.
    /// @param delta    Its net hook delta. Negative (owed BY the hook) and within the residue bound to settle.
    /// @param classId  The consent class the payload attributed the swap to; bears the residue.
    function _settleSingle(Currency currency, int256 delta, uint256 classId) private {
        address vault = IVaultRegistry(_registry).vaultForAsset(Currency.unwrap(currency));
        require(vault != address(0), Errors.TokenHasNoVault(Currency.unwrap(currency)));
        require(
            delta < 0 && uint256(-delta) <= MAX_JIT_ROUNDING_DUST, Errors.TokenHasNoVault(Currency.unwrap(currency))
        );

        uint256 owed = uint256(-delta);
        poolManager.sync(currency);
        IAssetVault(vault).settleVenueOut(classId, address(poolManager), owed);
        poolManager.settle();
    }

    // ============================================================
    // Internals; protocol fee
    //
    // A cut of a JIT swap that accrues to an Aqua0-controlled recipient. It is NOT the pool's Uniswap fee
    // (never overridden here) and NOT the LP's JIT earnings (those settle to the class's vaults in full). The
    // fee is charged in `beforeSwap` and paid in `afterSwap`; see `_afterSwap`'s @dev for why that split, and
    // that ordering, is what keeps the charge off the LP.
    // ============================================================

    /// @dev Resolve the rate a pool is charged: its own override when one is set, otherwise the global
    ///      rate. Exactly two steps, in that order, and nothing else feeds in.
    ///
    ///      Reading `set` rather than testing `ppb != 0` is the whole point. A pool deliberately waived by
    ///      an operator stores `set = true, ppb = 0` and resolves to 0; a pool with no override at all
    ///      stores `set = false` and resolves to the global rate. Collapsing those two into one test is the
    ///      failure this override type was shaped to prevent - the waived pool would silently fall through
    ///      and keep paying the global rate.
    /// @param pid The pool being priced.
    /// @return The rate in PARTS PER BILLION to charge this pool. Callers must have already established that
    ///         the seam is armed; this function does not consult `protocolFeeRecipient`.
    function _resolveProtocolFeePpb(PoolId pid) internal view returns (uint32) {
        V4Types.PoolProtocolFee memory pool = poolProtocolFee[pid];
        return pool.set ? pool.ppb : protocolFeePpb;
    }

    /// @dev Charge the protocol fee on a swap that has just consumed an Aqua0 payload, recording the amount
    ///      transiently for `_takeProtocolFee` and returning the before-swap delta that makes the SWAPPER pay
    ///      it. Returns ZERO (and writes nothing) whenever the seam is disarmed or the fee rounds to zero, so
    ///      an unconfigured adapter never enters a fee branch at all.
    ///
    ///      WHICH LEG. `beforeSwapReturnDelta` can only move the SPECIFIED amount, and `beforeSwap` is the
    ///      only place a fee can be charged at all (`afterSwapReturnDelta` is off and is not encoded in the
    ///      mined hook address, so it cannot be enabled without a redeploy). The fee is therefore charged on
    ///      whatever the swapper specified, in that currency: the input on an exact-input swap, the output on
    ///      an exact-output one.
    ///
    ///      WHY ONE SIGN WORKS FOR BOTH. A POSITIVE `deltaSpecified` is correct in both directions, and in
    ///      both the LP transacts at the pool's own rate and the swapper bears the fee:
    ///        - exact input  (`amountSpecified < 0`): v4-core computes `amountToSwap += fee`, SHRINKING the
    ///          swap. The swapper pays their full input and receives the output of `input - fee`.
    ///        - exact output (`amountSpecified > 0`): the same addition GROWS the swap. The pool sells
    ///          `output + fee`, the swapper still receives `output`, and pays the input for the larger amount.
    ///      In neither case is the LP's price altered - only the size of the trade it is filling.
    /// @param key    The pool being swapped (its id namespaces the transient slot).
    /// @param params The swap parameters; `amountSpecified` is the fee base.
    /// @return The before-swap delta charging the fee to the swapper, or ZERO when no fee is due.
    function _chargeProtocolFee(PoolKey calldata key, SwapParams calldata params) private returns (BeforeSwapDelta) {
        // Disarmed: return before touching anything, so the inert path is the pre-seam path exactly. This
        // check leads deliberately - it gates the per-pool overrides too, which is what keeps
        // `recipient == 0` meaning "charges nothing" no matter what overrides exist.
        if (protocolFeeRecipient == address(0)) return BeforeSwapDeltaLibrary.ZERO_DELTA;

        PoolId pid = key.toId();
        uint32 feePpb = _resolveProtocolFeePpb(pid);
        if (feePpb == 0) return BeforeSwapDeltaLibrary.ZERO_DELTA; // free pool, or no global rate set

        int256 specified = params.amountSpecified;
        uint256 base = specified < 0 ? uint256(-specified) : uint256(specified);
        uint256 fee = Math.mulDiv(base, feePpb, PROTOCOL_FEE_DENOMINATOR_PPB);
        // A fee that rounds to zero on a dust trade must not arm the take path: a zero transient write is
        // indistinguishable from "no fee charged", and returning ZERO here keeps the two consistent.
        if (fee == 0) return BeforeSwapDeltaLibrary.ZERO_DELTA;

        bytes32 ptrFee = keccak256(abi.encode(pid, TSLOT_LABEL_PROTOCOL_FEE));
        assembly ("memory-safe") {
            tstore(ptrFee, fee)
        }
        // `MAX_PROTOCOL_FEE_PPB` bounds the fee to 1% of an amount v4-core already handles as an int128, so
        // this cast cannot realistically narrow; it is checked anyway because it sizes a value that moves money.
        return toBeforeSwapDelta(SafeCast.toInt128(int256(fee)), 0);
    }

    /// @dev Pay the fee `_chargeProtocolFee` recorded for this pool to the recipient, and clear the slot. Must
    ///      run AFTER `_settleVirtualLiquidityDeltas`; the documentation on `_afterSwap` is where the reasoning
    ///      for that ordering lives.
    ///
    ///      The `take` leaves this hook owing the PoolManager exactly `fee`, which the before-swap delta
    ///      credits back once this callback returns. If those two ever disagreed, the unlock would fail
    ///      `CurrencyNotSettled` and the whole swap would revert - a loud failure, never a silent shortfall.
    ///      That is why the amount is read from the slot the charge wrote rather than recomputed here.
    /// @param key    The pool being swapped (its id namespaces the transient slot).
    /// @param params The ORIGINAL swap parameters, which name the specified currency the fee was charged in.
    function _takeProtocolFee(PoolKey calldata key, SwapParams calldata params) private {
        bytes32 ptrFee = keccak256(abi.encode(key.toId(), TSLOT_LABEL_PROTOCOL_FEE));
        uint256 fee;
        // Read and clear together: a second same-pool swap in this unlock must not re-pay this swap's fee,
        // mirroring the rangeCount/swapId clears the JIT path already does.
        assembly ("memory-safe") {
            fee := tload(ptrFee)
            tstore(ptrFee, 0)
        }
        if (fee == 0) return; // no fee armed for this swap

        // The specified currency, by v4-core's own rule (`Hooks.afterSwap`): it is currency0 exactly when
        // `amountSpecified < 0` agrees with `zeroForOne`. `params` here is the ORIGINAL struct the
        // PoolManager also passed to `beforeSwap`, so both callbacks resolve the same currency.
        Currency feeC = (params.amountSpecified < 0) == params.zeroForOne ? key.currency0 : key.currency1;
        address recipient = protocolFeeRecipient;
        // Only reachable if the seam were disarmed mid-unlock, between the charge and this take. Revert rather
        // than send a real fee to the zero address.
        require(recipient != address(0), Errors.ZeroAddress());

        poolManager.take(feeC, recipient, fee);
        emit Events.V4ProtocolFeeTaken(address(this), Currency.unwrap(feeC), recipient, fee);
    }

    // ============================================================
    // Internals; EIP-712
    // ============================================================

    /// @dev The EIP-712 domain separator, rebuilt each call from the frozen name/version hashes and the live
    ///      `chainId`/`address(this)`. Reading `block.chainid` live keeps the separator correct across a chain
    ///      fork without a stored cache.
    /// @return The domain separator for this adapter on the current chain.
    function _domainSeparator() internal view returns (bytes32) {
        return
            keccak256(abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, block.chainid, address(this)));
    }

    /// @dev Build the EIP-712 digest a JIT payload must be signed over. `rangesHash` binds the exact ranges
    ///      into the signature, so neither the swap params nor the liquidity ranges can be altered after
    ///      signing without invalidating it.
    /// @param p          The payload whose fields are hashed into the struct hash.
    /// @param rangesHash `keccak256(abi.encode(ranges))` for the ranges accompanying the payload.
    /// @return The final `\x19\x01`-prefixed EIP-712 digest to recover the signer from.
    function _buildDigest(V4Types.JITPayload memory p, bytes32 rangesHash) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                V4_JIT_TYPEHASH,
                p.swapId,
                p.poolId,
                p.classId,
                p.zeroForOne,
                p.amountSpecified,
                p.sqrtPriceLimitX96,
                p.nonce,
                p.deadline,
                p.executor,
                rangesHash
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }
}
