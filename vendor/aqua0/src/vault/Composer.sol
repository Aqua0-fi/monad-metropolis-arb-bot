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

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { EIP712Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { Roles } from "../lib/Roles.sol";
import { Events } from "../lib/Events.sol";
import { Errors } from "../lib/Errors.sol";
import { IVaultRegistry } from "../interface/IVaultRegistry.sol";
import { IAssetVault } from "../interface/IAssetVault.sol";
import { IFillerRegistry } from "../interface/IFillerRegistry.sol";

/// @title Composer
/// @author Aqua0 Team
/// @notice The single privileged actor that orchestrates vault capital across venue adapters, keyed by
///         consent class. Holds `COMPOSER_ROLE` on every vaults vault and drives their custody / settlement
///         seam (`deployCapital` / `returnCapital` / `onAdapterSettle`) under a strict authorization spine.
/// @dev Authorization is layered so no single key can move capital: (1) the caller holds `OPERATOR_ROLE`;
///      (2) every op carries a backend EIP-712 signature that must recover to `composerSigner`; (3) the
///      target adapter must be on the registry's trusted-adapter allowlist; (4) `op.router` must be on the
///      Composer's router allowlist; (5) signer nonces are single-use and
///      ops expire at a deadline; (6) capital deployments are metered by a per-vault rolling backstop
///      against a compromised signer draining via repeated pulls.
///
///      Layer (4) does not bound the destination on every action, so do not read it as one. `FRONT_RELEASE`
///      transfers the struck assets TO `op.router`, and there the allowlist is what bounds where capital
///      lands. `DEPLOY` and `RETURN` require the same allowlist and then move capital between the vault and
///      `op.adapter`, never touching `op.router` again; on those two actions the destination is bounded by
///      layer (3) alone, and layer (4) only pins the `router` field of the signed op. The Composer holds no
///      standing token allowances: the return path grants a per-call approval to the vault and revokes it
///      in the same call. A bounded `rescueTokens` sweeps residue under the same partition the adapters
///      enforce (a token with a registry vault can only ever be swept HOME). UUPS; upgrade authority is
///      the timelocked multisig (`UPGRADER_ROLE`).
contract Composer is
    Initializable,
    AccessControlUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    /// @notice Op discriminators for `execute`.
    uint8 public constant ACTION_DEPLOY = 0;
    uint8 public constant ACTION_RETURN = 1;
    uint8 public constant ACTION_SETTLE = 2;
    /// @notice Fulfill an async redeem (`op.amount` = requestId). Routed through the signed spine so the
    ///         settlement key never needs `COMPOSER_ROLE` on the vault directly.
    uint8 public constant ACTION_FULFILL_REDEEM = 3;
    /// @notice Reconcile a bridge landing (`op.classId`, `op.route`, `op.pnl` = settledDelta). Signed so a
    ///         replayed settlement cannot double-claw.
    uint8 public constant ACTION_BRIDGE_SETTLE = 4;
    /// @notice Harden a cross-chain front lock Locked -> Committed (`op.route` = frontId). Field discipline:
    ///         non-zero `route`, zero `settlementId`, zero `amount`/`pnl`.
    uint8 public constant ACTION_FRONT_COMMIT = 5;
    /// @notice Release a committed front toward the bridge (`op.route` = frontId, `op.router` = bridge). Field
    ///         discipline: non-zero `route`, allowlisted `router`, zero `settlementId`. The struck assets flow
    ///         vault -> Composer -> allowlisted router.
    uint8 public constant ACTION_FRONT_RELEASE = 6;
    /// @notice Credit a measured bridge landing to the destination class (`op.route` = frontId,
    ///         `op.settlementId` = delivery GUID, `op.amount` = landed amount to pull, `op.pnl` = the amount
    ///         originally struck on the source chain per its `FrontReleased` event - a shortfall against it
    ///         is written down rather than silently dropped). Field
    ///         discipline: non-zero `route`, non-zero `settlementId`, non-zero `amount`, `pnl` >= 0.
    uint8 public constant ACTION_FRONT_SETTLE = 7;

    /// @notice Record the destination-side obligations for a front: who is standing in, for whom, and what
    ///         they are owed. Moves no capital - it records who is on the hook - so it carries no adapter,
    ///         router, pnl or settlementId.
    uint8 public constant ACTION_FRONT_OPEN = 8;

    /// @notice Rolling window for the per-vault deployment meter (fixed/tumbling).
    uint256 public constant JIT_WINDOW = 1 days;

    /// @notice EIP-712 type hash for a multi-class Composer capital op.
    bytes32 public constant COMPOSER_OP_TYPEHASH = keccak256(
        "ComposerOp(uint8 action,address vault,uint256 classId,address adapter,address router,uint256 amount,int256 pnl,bytes32 route,bytes32 settlementId,bytes32 allocationsRoot,uint256 nonce,uint256 deadline)"
    );

    /// @notice One filler's leg of a front, committed to by `ComposerOp.allocationsRoot`.
    /// @dev Field order is hashing-significant: the root is `keccak256(abi.encode(beneficiary, allocations))`
    ///      with `allocations` sorted ascending by `filler`. Sorting makes the commitment independent of the
    ///      order the matcher's greedy fill produced, so an identical set cannot yield two different roots.
    struct FrontAllocation {
        address filler;
        uint256 amount;
        uint256 feeOwed;
    }

    /// @notice A backend-signed capital instruction, keyed by consent class.
    /// @dev DEPLOY/RETURN: `amount` is the principal and `pnl` is 0. SETTLE: `pnl` is the realized delta and
    ///      `amount`/`router` are 0/unchecked.
    struct ComposerOp {
        // One of the ACTION_* discriminators; selects the vault seam to drive.
        uint8 action;
        // Target vaults vault; must be registry-registered.
        address vault;
        // Consent class (== the vault's strategyId) the op is attributed to.
        uint256 classId;
        // Venue adapter; must be on the registry's trusted-adapter allowlist.
        address adapter;
        // Venue / bridge router; must be Composer-allowlisted for capital moves.
        address router;
        // Principal (DEPLOY/RETURN), requestId (FULFILL_REDEEM), or landed amount (FRONT_SETTLE).
        uint256 amount;
        // Realized delta (SETTLE/BRIDGE_SETTLE) or a 0/1 final-close sentinel (RETURN).
        int256 pnl;
        // Bridge route for ACTION_BRIDGE_SETTLE; zero for every other action.
        bytes32 route;
        // Identity of the bridge LANDING for ACTION_BRIDGE_SETTLE (e.g. the message GUID): the vault's
        // one-shot idempotency key. The composer nonce cannot serve here: a re-signed duplicate of the same
        // landing carries a fresh nonce. Zero for every other action.
        bytes32 settlementId;
        // Commitment to the `(filler, amount, feeOwed)[]` allocation set for ACTION_FRONT_OPEN; zero for every
        // other action. The array travels as calldata and is verified against this root before anything is
        // recorded, so the on-chain obligation set is provably the set the signer committed to rather than
        // merely one the caller asserts. A fixed-width commitment keeps the per-action "every unused field is
        // zero" discipline mechanical, which a variable-length blob would have degraded to a convention.
        bytes32 allocationsRoot;
        // Single-use signer nonce (replay protection); consumed by `_authorize`.
        uint256 nonce;
        // Unix timestamp after which the op is expired and rejected.
        uint256 deadline;
    }

    /// @notice Trusted asset->vault + adapter-allowlist source. Set at init.
    IVaultRegistry public registry;

    /// @notice Backend EIP-712 signer whose signature authorizes every op.
    address public composerSigner;

    /// @notice Venue routers the Composer will route capital toward.
    mapping(address => bool) public isDeployRouterAllowed;

    /// @notice Consumed signer nonces (single-use, replay protection).
    mapping(uint256 => bool) public usedNonces;

    /// @notice Per-vault rolling deployment limit (asset units; 0 means unarmed - every deploy is refused).
    mapping(address => uint256) public jitLimit;

    /// @notice Start timestamp of each vault's current meter window.
    // Written by `_meterJitWindow` (this file), not by a constructor. `uninitialized-state` only
    // counts constructor writes, so every mapping on an upgradeable contract trips it: there is no
    // constructor here by design, since UUPS initializes through `initialize`.
    // slither-disable-next-line uninitialized-state
    mapping(address => uint256) public jitWindowStart;

    /// @notice Raw deployment accumulator for each vault's current window (read the expiry-aware value via
    ///         `jitWindowDeployed`, not this slot).
    // Written alongside `jitWindowStart` in `_meterJitWindow`. Same constructor-only blind spot.
    // slither-disable-next-line uninitialized-state
    mapping(address => uint256) internal _jitWindowDeployed;

    /// @dev Reserved storage for append-only upgrades. Inherited OZ contracts use ERC-7201 namespaced
    ///      storage and do not consume these linear slots.
    /// @notice The participation registry consulted before a filler can be put on the hook for a front.
    /// @dev Zero disables the check, for chains where the registry is not deployed. Consent then rests on the
    ///      backend's selection filter alone, which is weaker - so this should be set wherever the registry
    ///      exists.
    address public fillerRegistry;

    /// @dev Reduced from 43 to 42: `fillerRegistry` consumes one reserved slot. Appending here and shrinking
    ///      the gap keeps every pre-existing variable at its original slot.
    uint256[42] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the Composer singleton proxy.
    /// @dev Reverts if any address is zero or `domainVersion` is empty. The EIP-712 domain NAME is the frozen
    ///      wire constant `"Composer"`, never renamed. The VERSION is a deploy parameter because name,
    ///      chainId and verifyingContract are all reproducible off a fork: a fork keeps the forked chain's
    ///      id, and a CREATE3 deploy lands at the same address, so without a distinct version a signature
    ///      minted against a fork deployment is structurally valid against the mainnet one. Mainnet uses
    ///      `"1"`; the deploy passes something else for a fork. Whatever is passed here is what the backend
    ///      must sign against, so it is recorded in the deployment record rather than assumed.
    /// @param admin Receives `DEFAULT_ADMIN_ROLE` (manages allowlists, meter limits, signer rotation, rescue).
    /// @param operator Receives `OPERATOR_ROLE` (relays backend-signed ops via `execute`).
    /// @param upgrader Receives `UPGRADER_ROLE` (the timelocked multisig; UUPS upgrade authority).
    /// @param registry_ The `VaultRegistry` (asset->vault map + trusted-adapter allowlist source).
    /// @param signer The backend EIP-712 `composerSigner` whose signature authorizes every op.
    /// @param domainVersion The EIP-712 domain version; `"1"` on mainnet.
    function initialize(
        address admin,
        address operator,
        address upgrader,
        address registry_,
        address signer,
        string calldata domainVersion
    ) external initializer {
        require(
            admin != address(0) && operator != address(0) && upgrader != address(0) && registry_ != address(0)
                && signer != address(0),
            Errors.ZeroAddress()
        );
        require(bytes(domainVersion).length != 0, Errors.EmptyDomainVersion());
        __AccessControl_init();
        __EIP712_init("Composer", domainVersion);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.OPERATOR_ROLE, operator);
        _grantRole(Roles.UPGRADER_ROLE, upgrader);
        // Self-administered: only an existing UPGRADER_ROLE holder can grant/revoke it, so DEFAULT_ADMIN_ROLE
        // alone can no longer self-grant upgrade authority over this contract.
        _setRoleAdmin(Roles.UPGRADER_ROLE, Roles.UPGRADER_ROLE);

        registry = IVaultRegistry(registry_);
        composerSigner = signer;
        emit Events.ComposerSignerSet(address(0), signer);
    }

    // ============================================================
    // Execution
    // ============================================================

    /// @notice Execute a backend-signed capital op against a vaults vault.
    /// @dev Caller must hold `OPERATOR_ROLE`; `sig` must recover to `composerSigner` over the op. The op's
    ///      adapter must be registry-allowlisted, and (for capital moves) its router Composer-allowlisted.
    ///      Nonce is consumed and the deadline enforced; deployments are metered. `nonReentrant` guards the
    ///      adapter -> Composer -> vault hand-offs (`_return` / `_frontRelease` / `_frontSettle`). Reverts
    ///      `UnknownComposerAction` on an unrecognized discriminator.
    /// @param op The backend-signed capital instruction (see `ComposerOp` for per-action field discipline).
    /// @param sig The EIP-712 signature over `hashOp(op)`; must recover to `composerSigner`.
    function execute(ComposerOp calldata op, bytes calldata sig) external onlyRole(Roles.OPERATOR_ROLE) nonReentrant {
        _authorize(op, sig);

        if (op.action == ACTION_DEPLOY) {
            _deploy(op);
        } else if (op.action == ACTION_RETURN) {
            _return(op);
        } else if (op.action == ACTION_SETTLE) {
            IAssetVault(op.vault).onAdapterSettle(op.classId, op.adapter, op.pnl);
        } else if (op.action == ACTION_FULFILL_REDEEM) {
            IAssetVault(op.vault).fulfillRedeem(op.amount);
        } else if (op.action == ACTION_BRIDGE_SETTLE) {
            IAssetVault(op.vault).onBridgeSettle(op.classId, op.route, op.settlementId, op.pnl);
        } else if (op.action == ACTION_FRONT_COMMIT) {
            IAssetVault(op.vault).commitFrontLock(op.classId, op.route);
        } else if (op.action == ACTION_FRONT_RELEASE) {
            _frontRelease(op);
        } else if (op.action == ACTION_FRONT_SETTLE) {
            _frontSettle(op);
        } else {
            revert Errors.UnknownComposerAction(op.action);
        }

        emit Events.ComposerExecuted(op.vault, op.adapter, op.action, op.amount, op.pnl, op.nonce);
    }

    /// @notice `execute` for ACTION_FRONT_OPEN, which carries a variable-length allocation set.
    /// @dev The set travels as CALLDATA and is verified against `op.allocationsRoot` before anything is
    ///      recorded, so the signature commits to exactly the obligations that get written. A caller cannot
    ///      substitute, reorder, add or drop a filler, or swap the beneficiary, without failing verification.
    ///      A separate entry point rather than an overload of `execute`: the allocation set is meaningless for
    ///      every other action, and threading an always-empty array through them would invite someone to pass
    ///      a non-empty one.
    /// @param op The signed op; `action` must be ACTION_FRONT_OPEN.
    /// @param sig The EIP-712 signature over `hashOp(op)`.
    /// @param beneficiary The source-chain LP the fillers are standing in for; covered by the root.
    /// @param allocations The `(filler, amount, feeOwed)` set committed to by `op.allocationsRoot`.
    function executeFrontOpen(
        ComposerOp calldata op,
        bytes calldata sig,
        address beneficiary,
        FrontAllocation[] calldata allocations
    ) external onlyRole(Roles.OPERATOR_ROLE) nonReentrant {
        require(op.action == ACTION_FRONT_OPEN, Errors.UnknownComposerAction(op.action));
        _authorize(op, sig);
        _frontOpen(op, beneficiary, allocations);
        emit Events.ComposerExecuted(op.vault, op.adapter, op.action, op.amount, op.pnl, op.nonce);
    }

    /// @notice Record every filler leg of a front on the destination vault, after proving the allocation set
    ///         is the one the signer committed to and that each filler consented to front.
    ///
    /// @dev THE ROOT IS THE POINT. Without it, "the contract honours the reservation" rests on the relayer
    ///      having passed the right numbers. With it, the numbers written on-chain are provably the numbers
    ///      signed, and a mismatch is a failed verification rather than a silent divergence in who gets paid.
    ///
    ///      CONSENT IS CHECKED HERE, not in the vault. Fronting pledges an LP's principal to stand in for a
    ///      stranger's capital, so a filler must have opted in explicitly - and the registry is read
    ///      LITERALLY: `isParticipating` false, including the default for an LP who never called it, means NOT
    ///      participating. It lives here because wiring the registry into `AssetVault` would cost storage plus
    ///      a setter on a contract with ~370 bytes of margin, while this contract has thousands. The property
    ///      is identical - consent is an on-chain precondition, not a backend convention - and the vault entry
    ///      point is reachable only through this contract's COMPOSER_ROLE, which the deploy script asserts.
    /// @param op The signed FRONT_OPEN op; `route` is the frontId and `amount` the total front size.
    /// @param allocations The per-filler set committed to by `op.allocationsRoot`.
    function _frontOpen(ComposerOp calldata op, address beneficiary, FrontAllocation[] calldata allocations) private {
        uint256 n = allocations.length;
        require(n > 0, Errors.EmptyAllocationSet(op.route));

        // Sorted-ascending by filler and hashed with abi.encode, matching the signer. Sorting is what makes
        // the root independent of the order the matcher's greedy fill happened to produce; a duplicate filler
        // is REFUSED rather than summed, because it means the matcher produced something it should not have
        // and summing would hide that.
        uint256 total;
        for (uint256 i; i < n; ++i) {
            if (i > 0) {
                require(
                    uint160(allocations[i].filler) > uint160(allocations[i - 1].filler),
                    Errors.AllocationsNotSorted(op.route, allocations[i].filler)
                );
            }
            total += allocations[i].amount;
        }
        require(
            keccak256(abi.encode(beneficiary, allocations)) == op.allocationsRoot,
            Errors.AllocationsRootMismatch(op.route, op.allocationsRoot)
        );
        // The declared front size must equal what the committed set actually pledges, so `amount` cannot claim
        // a front larger than the obligations that back it.
        require(total == op.amount, Errors.AllocationsTotalMismatch(op.route, total, op.amount));

        // FAIL CLOSED. An earlier version skipped the check when the registry was unset, which - combined
        // with the variable having no setter - made consent enforcement unreachable: permanently address(0),
        // permanently skipped, and nothing reverting to say so. Fronting pledges an LP's principal to stand in
        // for a stranger's capital, so an unverifiable consent must refuse rather than assume. The vaults
        // deploy a registry on every chain, so this is a misconfiguration, not a supported mode.
        address registry_ = fillerRegistry;
        require(registry_ != address(0), Errors.FillerRegistryUnset());
        for (uint256 i; i < n; ++i) {
            address filler = allocations[i].filler;
            require(IFillerRegistry(registry_).isParticipating(filler), Errors.FillerNotOptedIn(filler));
            IAssetVault(op.vault).openFrontObligation(
                op.classId, op.route, filler, beneficiary, allocations[i].amount, allocations[i].feeOwed
            );
        }
    }

    // ============================================================
    // Admin
    // ============================================================

    /// @notice Point the Composer at the participation registry consulted before a filler can be put on the
    ///         hook for a front.
    /// @dev Timelocked admin. Required before any `FRONT_OPEN` succeeds: `_frontOpen` refuses while this is
    ///      unset rather than skipping the consent check, so a Composer that was never configured cannot front
    ///      at all. Settable rather than immutable because the registry is non-upgradeable and could be
    ///      redeployed independently of the vaults.
    /// @param registry_ The `FillerRegistry` for this chain; zero disables fronting entirely.
    function setFillerRegistry(address registry_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        fillerRegistry = registry_;
        emit Events.FillerRegistrySet(address(this), registry_);
    }

    /// @notice Add or remove a venue router from the allowlist.
    /// @dev Only allowlisted routers are valid capital-move targets (`_deploy` / `_return`); reverts on zero.
    /// @param router The venue router address to toggle.
    /// @param allowed True to allow the router as a capital-move target, false to remove it.
    function setDeployRouterAllowed(address router, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(router != address(0), Errors.ZeroAddress());
        isDeployRouterAllowed[router] = allowed;
        emit Events.ComposerDeployRouterAllowlisted(router, allowed);
    }

    /// @notice Set a vault's rolling deployment meter limit in asset units. 0 leaves (or resets) the vault
    ///         UNDEPLOYABLE - `_deploy` refuses every DEPLOY op for it (`JitLimitUnset`) until a real ceiling
    ///         is armed here. There is no "unlimited" setting; size the limit to the vault's real capacity.
    /// @dev The meter is a backstop against a compromised signer draining a vault via repeated deploys within
    ///      one `JIT_WINDOW`.
    /// @param vault The vault whose per-window deployment cap is set.
    /// @param limit The rolling deployment ceiling in asset units for that vault (0 blocks all deploys).
    function setJitLimit(address vault, uint256 limit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        jitLimit[vault] = limit;
        emit Events.ComposerJitLimitSet(vault, limit);
    }

    /// @notice Rotate the backend signer key.
    /// @dev Reverts on a zero signer. Emits the old and new signer so a rotation is auditable from events.
    /// @param signer The new `composerSigner` whose signature will authorize subsequent ops.
    function setComposerSigner(address signer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(signer != address(0), Errors.ZeroAddress());
        address old = composerSigner;
        composerSigner = signer;
        emit Events.ComposerSignerSet(old, signer);
    }

    /// @notice Sweep `amount` of a stray token out of the Composer (a fee-on-transfer remainder, a mis-sent
    ///         token, an airdrop). Same partition the venue adapters enforce: a token that has EVER had a
    ///         registry vault may only be swept to its CURRENT vault, so no admin key gains a path to vault
    ///         capital.
    /// @dev Keyed on the permanent `isVaultedAsset` flag rather than the clearable `vaultForAsset` edge. A
    ///      deregistered asset has no current vault, so it is not sweepable at all here until a replacement
    ///      vault is registered for it (deregister-then-rescue can no longer divert vault capital). Reverts on a
    ///      zero token/`to`, a zero amount, or a `to` that is not the token's current vault when it is vaulted.
    /// @param token The stray ERC-20 to sweep out of the Composer.
    /// @param to The recipient; forced to the token's current vault whenever the token is vault-backed.
    /// @param amount The amount to sweep; must be non-zero.
    function rescueTokens(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        require(token != address(0) && to != address(0), Errors.ZeroAddress());
        require(amount > 0, Errors.ZeroAmount());

        address vault = registry.vaultForAsset(token);
        require(!registry.isVaultedAsset(token) || to == vault, Errors.TokenHasVault(token, vault));

        IERC20(token).safeTransfer(to, amount);
        emit Events.ComposerTokensRescued(token, to, amount);
    }

    // ============================================================
    // Views
    // ============================================================

    /// @notice The EIP-712 digest a `composerSigner` must sign for `op`.
    /// @param op The capital op to hash under `COMPOSER_OP_TYPEHASH` and this contract's domain.
    /// @return The typed-data digest to sign / recover against.
    function hashOp(ComposerOp calldata op) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    COMPOSER_OP_TYPEHASH,
                    op.action,
                    op.vault,
                    op.classId,
                    op.adapter,
                    op.router,
                    op.amount,
                    op.pnl,
                    op.route,
                    op.settlementId,
                    op.allocationsRoot,
                    op.nonce,
                    op.deadline
                )
            )
        );
    }

    /// @notice Window-expiry-aware deployment spend in a vault's live meter window (0 once rolled).
    /// @dev Reads 0 once the window has elapsed, mirroring the reset `_meterDeploy` applies on the next deploy;
    ///      do not read the raw `_jitWindowDeployed` slot, which is stale past the window.
    /// @param vault The vault whose current-window deployment spend is read.
    /// @return The asset units deployed in the vault's live window (0 if the window has rolled).
    function jitWindowDeployed(address vault) public view returns (uint256) {
        if (block.timestamp >= jitWindowStart[vault] + JIT_WINDOW) return 0;
        return _jitWindowDeployed[vault];
    }

    /// @notice Non-reverting JIT-meter pre-check: reports whether a deploy of `amount` against `vault` would
    ///         breach its current window and, if so, emits the SAME `JitMeterBreach` alarm `_meterDeploy`
    ///         would emit. Never reverts and mutates NO meter state (a real `execute()` DEPLOY still runs its
    ///         own live check).
    /// @dev `_meterDeploy`'s own `emit ... ; revert ...` pair is unobservable on-chain: a revert discards
    ///      every log from that call, so the compromised-signer backstop the NatSpec describes can never
    ///      actually appear in transaction receipts. This is the fix: an operator/relayer polls this
    ///      function (a real, succeeding transaction, so its log DOES persist) before submitting the
    ///      corresponding `execute()` DEPLOY, giving the alarm an on-chain-observable path.
    ///      Permissionless: it moves no funds and changes no
    ///      functional state, so restricting the caller would only reduce who can watch for it.
    /// @param vault The vault a DEPLOY would target.
    /// @param adapter The adapter the would-be DEPLOY op names (event context only, mirrors `_meterDeploy`).
    /// @param amount The deploy amount to preview against the vault's live meter window.
    /// @return wouldBreach True if this amount would push the window past the vault's limit.
    /// @return remaining The window budget remaining right now (0 if already exhausted or unarmed).
    function previewMeterDeploy(address vault, address adapter, uint256 amount)
        external
        returns (bool wouldBreach, uint256 remaining)
    {
        uint256 limit = jitLimit[vault];
        uint256 spent = jitWindowDeployed(vault);
        remaining = limit > spent ? limit - spent : 0;
        wouldBreach = limit == 0 || amount > remaining;
        if (wouldBreach) emit Events.JitMeterBreach(vault, adapter, amount, remaining);
    }

    // ============================================================
    // Internals
    // ============================================================

    /// @dev The full authorization spine, shared by every op. Consumes the nonce. Enforced order: deadline not
    ///      expired, nonce unused (then marked used), signature recovers to `composerSigner`, vault registered,
    ///      adapter registry-allowlisted. Router allowlisting is left to the capital-move handlers.
    /// @param op The op being authorized (its full field set is bound into the signed digest).
    /// @param sig The EIP-712 signature to recover and check against `composerSigner`.
    function _authorize(ComposerOp calldata op, bytes calldata sig) internal {
        require(block.timestamp <= op.deadline, Errors.ComposerPayloadExpired(op.deadline, block.timestamp));
        require(!usedNonces[op.nonce], Errors.ComposerNonceUsed(op.nonce));
        usedNonces[op.nonce] = true;

        address recovered = ECDSA.recover(hashOp(op), sig);
        require(recovered == composerSigner, Errors.NotComposerSigner(recovered, composerSigner));

        require(registry.isVault(op.vault), Errors.VaultNotRegistered(op.vault));
        // Every capital-moving action names a venue adapter and must prove it is allowlisted. FRONT_OPEN is
        // exempt because it names none: it records who is on the hook for a front and moves nothing, so
        // demanding a venue adapter would be a check with no subject - and would force the field to carry a
        // meaningless non-zero value, defeating the per-action "every unused field is zero" discipline that
        // makes the rest of these ops mechanically checkable. The field is asserted zero for FRONT_OPEN below.
        if (op.action != ACTION_FRONT_OPEN) {
            require(registry.isAllowedAdapter(op.adapter), Errors.AdapterNotAllowed(op.adapter));
        } else {
            require(
                op.adapter == address(0) && op.router == address(0) && op.pnl == 0 && op.settlementId == bytes32(0),
                Errors.UnusedFieldNonZero(op.action)
            );
        }
    }

    /// @dev Committed deploy: assert the router allowlist, meter the vault, then move idle capital out to a
    ///      class's venue. Reverts on a zero amount or a non-allowlisted router.
    /// @param op The DEPLOY op (`amount` = principal, `router` = allowlisted venue router).
    function _deploy(ComposerOp calldata op) internal {
        require(op.amount > 0, Errors.ZeroAmount());
        require(isDeployRouterAllowed[op.router], Errors.ComposerRouterNotAllowed(op.router));
        _meterDeploy(op.vault, op.adapter, op.amount);
        IAssetVault(op.vault).deployCapital(op.classId, op.adapter, op.amount);
    }

    /// @dev Return path: pull the returning principal from the venue `adapter` (which grants a bounded,
    ///      immediately-consumed approval) into the Composer, grant the vault a per-call approval, hand it
    ///      back via the vault's FOT-safe pull, then revoke. Capital flows adapter -> Composer -> vault with
    ///      no standing allowance on either leg. FOT-safe: the inbound leg is measured and only what
    ///      ARRIVED is approved and handed on, so a fee-on-transfer return completes instead of stranding.
    /// @param op The RETURN op (`amount` = returning principal, `pnl` = 0/1 final-close sentinel).
    function _return(ComposerOp calldata op) internal {
        require(op.amount > 0, Errors.ZeroAmount());
        require(isDeployRouterAllowed[op.router], Errors.ComposerRouterNotAllowed(op.router));
        // `pnl` on a RETURN is a BOOLEAN final-close sentinel (0 = ordinary/partial, 1 = final close), NEVER a PnL
        // value. Enforce it ON-CHAIN, not just in the off-chain signer: a final close charges the return shortfall
        // as a realized loss against LP principal, so a raw PnL number miswired into a RETURN's `pnl` (a different
        // signer, a compromised backend, a future-removed off-chain check) would silently realize a loss on
        // recoverable capital. This is `_return`-scoped ONLY: `pnl` legitimately carries a signed delta on
        // SETTLE / BRIDGE_SETTLE. `_return` only ever reads `pnl != 0`, so restricting it to {0,1} discards nothing.
        require(op.pnl == 0 || op.pnl == 1, Errors.InvalidReturnSentinel(op.pnl));

        IERC20 asset = IERC20(IAssetVault(op.vault).asset());

        uint256 before = asset.balanceOf(address(this));
        // `op.adapter` is not an attacker-chosen `from`: `_authorize` requires the EIP-712 op (whose typehash
        // covers `adapter`) to recover to `composerSigner` AND to pass `registry.isAllowedAdapter(op.adapter)`;
        // the adapter itself grants a bounded, immediately-consumed approval for this exact pull.
        // slither-disable-next-line arbitrary-send-erc20
        asset.safeTransferFrom(op.adapter, address(this), op.amount);
        uint256 received = asset.balanceOf(address(this)) - before;
        require(received > 0, Errors.ZeroAmount());

        asset.forceApprove(op.vault, received);
        // On a RETURN, `pnl` is a BOOLEAN FINAL-CLOSE SENTINEL, NOT a PnL value: `pnl == 0` is an ordinary/partial
        // return; any non-zero `pnl` means final close. The struct is unchanged (`pnl` is unused by RETURN
        // otherwise). On a final close the vault charges any return shortfall (`deployed - received`) as a realized
        // loss and fully unwinds, so it must NOT be set while capital is still legitimately at the venue: a raw PnL
        // number signed into a RETURN's `pnl` would trigger that loss by accident. The signer must emit 0 or 1 only.
        IAssetVault(op.vault).returnCapital(op.classId, op.adapter, received, op.pnl != 0);
        asset.forceApprove(op.vault, 0);
    }

    /// @dev Front release: the vault strikes/burns/meters the committed lock and hands the struck assets to
    ///      this Composer, which forwards them to the allowlisted bridge router (recipient = the destination
    ///      vault; the concrete bridge-call encoding is the settlement worker's, out of the on-chain seam).
    ///      Same vault<->Composer hand-off as `_return`, reversed: capital flows vault -> Composer -> router
    ///      with no standing allowance. `Released` is terminal on the vault, so this is single-shot per front.
    /// @dev FOT-safe: forwards the MEASURED balance delta from the
    ///      vault's `safeTransfer`, not the vault's reported `released` amount. On a fee-on-transfer vault
    ///      asset the two can differ - forwarding the reported (larger) amount would attempt to send more
    ///      than this Composer actually holds and revert the whole release.
    /// @param op The FRONT_RELEASE op (`route` = frontId, `router` = allowlisted bridge router).
    function _frontRelease(ComposerOp calldata op) internal {
        require(isDeployRouterAllowed[op.router], Errors.ComposerRouterNotAllowed(op.router));
        IERC20 asset = IERC20(IAssetVault(op.vault).asset());
        uint256 before = asset.balanceOf(address(this));
        IAssetVault(op.vault).releaseFrontToBridge(op.classId, op.route);
        uint256 received = asset.balanceOf(address(this)) - before;
        asset.safeTransfer(op.router, received);
    }

    /// @dev Front settle: grant the vault a bounded, immediately-consumed approval and hand it the
    ///      bridge-landed tokens this Composer holds, which the vault credits by the MEASURED delta (a signed
    ///      `amount` can never inflate class idle beyond what physically transfers in). Same no-standing-
    ///      allowance idiom as `_return`. The vault's one-shot `settlementId` key makes it single-settle.
    /// @param op The FRONT_SETTLE op (`route` = frontId, `settlementId` = delivery GUID, `amount` = landed).
    function _frontSettle(ComposerOp calldata op) internal {
        require(op.amount > 0, Errors.ZeroAmount());
        // `pnl` is repurposed on FRONT_SETTLE as the originally-struck source-chain amount (relayed from its
        // FrontReleased event), never a real PnL delta here. Must be non-negative - it is a locked principal
        // figure, not a signed valuation mark.
        require(op.pnl >= 0, Errors.InvalidLockedAmount(op.pnl));
        IERC20 asset = IERC20(IAssetVault(op.vault).asset());
        asset.forceApprove(op.vault, op.amount);
        IAssetVault(op.vault).creditFrontLanding(op.classId, op.route, op.settlementId, op.amount, uint256(op.pnl));
        asset.forceApprove(op.vault, 0);
    }

    /// @dev Per-vault rolling deployment meter. Reverts (and emits the monitor alarm) if a deploy would
    ///      push the window past the vault's limit. `jitLimit == 0` means the meter was never armed for this
    ///      vault, NOT "unlimited" - a deploy is refused outright (`JitLimitUnset`) until an admin arms a
    ///      real ceiling via `setJitLimit`, mirroring the `venueOutflowLimit`-at-init pattern on AssetVault.
    ///      Fixed-grid window: once `JIT_WINDOW` has elapsed, `start` snaps FORWARD to the fixed grid point
    ///      at or before `now`, NOT to `block.timestamp` itself - a tumbling reset would let whoever triggers
    ///      the reset transaction pick the new window's phase, letting a compromised/careless signer draw the
    ///      full limit at the tail of one window and immediately again at the head of the next, repeatable
    ///      every cycle for a sustained ~2x rate rather than a one-time boundary straddle.
    /// @param vault The vault being metered.
    /// @param adapter The target adapter (event context for the breach alarm).
    /// @param amount The deploy amount to add to the current window's spend.
    function _meterDeploy(address vault, address adapter, uint256 amount) internal {
        uint256 limit = jitLimit[vault];
        require(limit != 0, Errors.JitLimitUnset(vault));

        uint256 start = jitWindowStart[vault];
        uint256 spent;
        if (block.timestamp >= start + JIT_WINDOW) {
            // The divide-then-multiply is intentional integer flooring: it snaps `start` forward to the
            // most recent whole-WINDOW boundary, so the grid stays fixed-phase. Exact by construction, not a
            // precision loss.
            // slither-disable-next-line divide-before-multiply
            start += ((block.timestamp - start) / JIT_WINDOW) * JIT_WINDOW;
            spent = 0;
        } else {
            spent = _jitWindowDeployed[vault];
        }

        uint256 newSpent = spent + amount;
        if (newSpent > limit) {
            uint256 remaining = limit > spent ? limit - spent : 0;
            emit Events.JitMeterBreach(vault, adapter, amount, remaining);
            revert Errors.JitMeterExceeded(vault, amount, remaining);
        }

        jitWindowStart[vault] = start;
        _jitWindowDeployed[vault] = newSpent;
    }

    /// @dev UUPS upgrade authority. Gated to `UPGRADER_ROLE` (the timelocked multisig).
    /// @param newImplementation The candidate implementation the proxy would point at; authority is role-gated
    ///        here, and the implementation itself is validated by the ERC-1967 upgrade machinery.
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(Roles.UPGRADER_ROLE) { }
}
