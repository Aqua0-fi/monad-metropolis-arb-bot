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
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC5267 } from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import { IVenueAdapter } from "../interface/IVenueAdapter.sol";
import { IAqua } from "../interface/IAqua.sol";
import { IAssetVault } from "../interface/IAssetVault.sol";
import { Alloc } from "../lib/Types.sol";
import { IMakerHooks } from "../interface/IMakerHooks.sol";
import { ISwapVMRouter } from "../interface/ISwapVMRouter.sol";
import { IVaultRegistry } from "../interface/IVaultRegistry.sol";
import { Roles } from "../lib/Roles.sol";
import { Events } from "../lib/Events.sol";
import { Errors } from "../lib/Errors.sol";

/// @title AquaAdapter
/// @author Aqua0 Team
/// @notice The vaults' venue adapter for the 1inch Aqua venue (executed by the SwapVM engine), and the Aqua
///         maker for every strategy it ships. Aqua is to this adapter what a V4 PoolManager is to V4Adapter.
///
/// @dev NON-CUSTODIAL AT REST. This adapter holds no capital between swaps. `Aqua.ship` writes virtual
///      balances only, it moves no tokens, checks no balance, checks no allowance, and the router hands
///      this adapter execution immediately before it pulls, via the maker hooks:
///
///        transferOut leg:  preTransferOut  -> Aqua.pull (tokenOut: adapter -> taker)
///        transferIn  leg:  Aqua.push (tokenIn: router -> adapter) -> postTransferIn
///
///      `preTransferOut` sources `amountOut` of `tokenOut` from that token's vault just in time for the pull
///      and approves Aqua exactly that much (the pull consumes it to zero); `postTransferIn` sweeps the
///      pushed `amountIn` into `tokenIn`'s vault. The swap runs the two legs in either order (the taker
///      picks); the hooks are independent, so both orderings are correct.
///
///      SECURITY:
///        - The hooks are public entry points that move vault capital. Both require `msg.sender ==
///          aquaSwapVMRouter`; without that, anyone drains a vault.
///        - `takerData` is taker-controlled and hostile. It is never read.
///        - `orderHash` must resolve to a live strategy this adapter shipped (a reverse index). A taker
///          cannot forge one: `Aqua.ship` takes the maker from `msg.sender`, so only this contract can
///          author an order whose maker is this contract.
///        - `shipStrategy` decodes the order and rejects traits that would skip or redirect the seam.
///        - Reentrancy: router -> hook -> vault -> transfer; hooks are `nonReentrant` and the router wraps
///          each fill in its own per-order guard.
///
///      BACKING. `Aqua.ship` escrows nothing, so a shipped virtual reserve is not physically backed. A swap
///      pulls from the vault at settle time. `shipStrategy` checks each token's reserve against that token's
///      vault idle for the class at ship time (advisory; vault idle can change before a swap); the
///      authoritative backstop is `settleVenueOut`'s own-idle debit, which reverts an over-shipped pull
///      rather than settling it unbacked. See `_requireVaultBacks`.
///
///      RESIDUAL INVENTORY. `Aqua.push` is permissionless, so anyone may donate into a live strategy, and
///      airdrops happen. Vault-backed tokens leave only through the Composer (`approveComposerReturn`);
///      everything else through `rescueUnvaultedToken`, which can never touch a vault-backed token (the
///      registry's vaulted-asset partition is permanent). Every strategy token must have a vault, so
///      `rescueUnvaultedToken` can never reach a live strategy's collateral.
contract AquaAdapter is IVenueAdapter, IMakerHooks, AccessControl, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Stable venue identifier.
    bytes32 public constant VENUE_ID = keccak256("Aqua");

    /// @notice The EIP-712 names an accepted SwapVM router may report, asserted in the constructor. BOTH are
    ///         accepted, and the second is the one that matters now: every chain this fleet binds resolves to
    ///         the 1inch router reporting `1inch SwapVM v1.0`, so `AquaSwapVMRouter` is the legacy name of the
    ///         self-deployed build no chain binds any more. Functional equivalence of the `1inch SwapVM v1.0`
    ///         build was verified in test/fork/RobinhoodSwapVM.fork.t.sol: same maker hooks at the same
    ///         MakerTraits bits, same JIT seam. This name check is only a look-alike FILTER; the real safety
    ///         is the `router.AQUA() == aqua` assertion below, which binds the adapter to the exact Aqua the
    ///         router reads, so a second accepted name cannot bind a router that resolves balances against a
    ///         different Aqua.
    bytes32 internal constant EXPECTED_ROUTER_NAME_HASH = keccak256("AquaSwapVMRouter");
    bytes32 internal constant EXPECTED_ROUTER_NAME_HASH_V1 = keccak256("1inch SwapVM v1.0");

    /// @notice Maximum tokens a single strategy may reference. Bounds the ship/dock loops.
    /// @dev Also bounds the O(n^2) duplicate-token scan in `_commitShipTokens`, keeping ship gas predictable.
    uint256 public constant MAX_STRATEGY_TOKENS = 20;

    /// @notice Cap on ship-equivalent calls per block. Bounds a compromised operator's blast radius.
    /// @dev Both `shipStrategy` and `reshipStrategy` count against it, so a leaked operator key cannot flood
    ///      the block with fresh depth faster than the guardian can pause upstream.
    uint256 public constant MAX_SHIPS_PER_BLOCK = 3;

    /// @notice Timelock delay before a proposed Composer swap can be accepted. No instant swap.
    uint256 public constant COMPOSER_TIMELOCK = 2 days;

    // MakerTraits bits, pinned against deployed bytecode (see test/fork/SwapVMRouterPairing.fork.t.sol). These
    // are single flag positions in the order's `traits` word; `_validateStrategyBytes` asserts the exact set
    // below, so a curve can neither skip a settlement hook nor redirect one off the maker.
    /// @dev `shouldUnwrapWeth`. Forbidden: Aqua does not support unwrap on this seam.
    uint256 internal constant TRAIT_SHOULD_UNWRAP_WETH = 1 << 255;
    /// @notice `useAquaInsteadOfSignature`. Required: the strategy is authorized by its Aqua ship, not a sig.
    uint256 public constant TRAIT_USE_AQUA = 1 << 254;
    /// @notice `hasPreTransferInHook`. Not implemented by this adapter.
    uint256 public constant TRAIT_PRE_TRANSFER_IN = 1 << 252;
    /// @notice `hasPostTransferInHook`. Required: the tokenIn sweep.
    uint256 public constant TRAIT_POST_TRANSFER_IN = 1 << 251;
    /// @notice `hasPreTransferOutHook`. Required: the tokenOut just-in-time source.
    uint256 public constant TRAIT_PRE_TRANSFER_OUT = 1 << 250;
    /// @notice `hasPostTransferOutHook`. Not implemented by this adapter.
    uint256 public constant TRAIT_POST_TRANSFER_OUT = 1 << 249;
    /// @dev Bits 248..245: "this hook has an explicit target." All must be clear so both hooks reach the maker
    ///      (this adapter) and cannot be redirected to an attacker-chosen target.
    uint256 internal constant TRAIT_HOOK_TARGET_BITS = (1 << 248) | (1 << 247) | (1 << 246) | (1 << 245);
    /// @dev Low 160 bits: the order's custom receiver. Must be zero or this adapter, since Aqua forbids
    ///      delivering `tokenOut` to a receiver other than the maker on this seam.
    uint256 internal constant TRAIT_RECEIVER_MASK = type(uint160).max;

    /// @notice The exact hook configuration every strategy must carry; `shipStrategy` rejects anything else.
    uint256 public constant REQUIRED_TRAITS = TRAIT_USE_AQUA | TRAIT_PRE_TRANSFER_OUT | TRAIT_POST_TRANSFER_IN;

    // EIP-712 domain. The domain NAME is a frozen wire constant: the strategist signs against it, so it must
    // survive a Solidity rename and is not derived from the contract name.
    /// @dev Standard EIP-712 domain typehash. The domain binds `chainId` and `verifyingContract`, so a signed
    ///      lifecycle action cannot be replayed on another chain or another adapter.
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @dev Frozen domain name (pinned by test/vault/EIP712Domains.t.sol); a contract rename must NOT move it.
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("AquaAdapter");
    /// @notice EIP-712 domain version hash, `keccak256(version)`, bound at construction.
    /// @dev A deploy parameter, not a constant, because name, chainId and verifyingContract are all
    ///      reproducible off a fork, so without a distinct version an action signed against a fork deployment
    ///      is structurally valid against the mainnet one. Mainnet passes `"1"`; a fork passes something else.
    ///      Bumping the mainnet value invalidates every previously-signed action.
    bytes32 public immutable DOMAIN_VERSION_HASH;

    /// @notice The strategist authorizes each lifecycle action by signing one of these. The operator only
    ///         relays; authority travels in the signature, so a compromised operator cannot ship a curve no
    ///         strategist signed. Verified with `SignatureChecker` (ERC-1271), because the strategist is a
    ///         smart wallet.
    bytes32 public constant SHIP_STRATEGY_TYPEHASH = keccak256(
        "ShipStrategy(uint256 classId,bytes32 strategyId,address[] tokens,uint256[] amounts,uint256 nonce,uint256 deadline)"
    );
    /// @notice EIP-712 typehash for a ship that DECLARES the strategy's maker-fee rate.
    /// @dev A sibling selector rather than a replacement, so no step of the rollout breaks shipping: the
    ///      contract carries both, the backend routes on presence of a rate, the web-app switches when ready,
    ///      and the old selector is retired last. A strategy shipped through the old path simply has no
    ///      declared rate and charges no maker fee - which is exactly today's behaviour, so those strategies
    ///      are fee-free rather than degraded.
    bytes32 public constant SHIP_STRATEGY_FEE_TYPEHASH = keccak256(
        "ShipStrategy(uint256 classId,bytes32 strategyId,address[] tokens,uint256[] amounts,uint32 feePpb,uint256 nonce,uint256 deadline)"
    );

    /// @notice Hard ceiling on a declared fee rate: the router's own maximum, where 1e9 == 100%.
    /// @dev Matches `Fee.BPS` in the bound SwapVM build, proven by execution in AquaFeeOpcodes.fork.t.sol at
    ///      0.3% and 30%. Bounding tighter here would refuse programs the router accepts; the product ceiling
    ///      belongs at the API, which is the last layer that can refuse before a digest is signed.
    uint32 public constant MAX_FEE_PPB = 1_000_000_000;

    bytes32 public constant RESHIP_STRATEGY_TYPEHASH = keccak256(
        "ReshipStrategy(bytes32 strategyId,bytes32 newStrategyId,uint256[] newAmounts,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant DOCK_STRATEGY_TYPEHASH =
        keccak256("DockStrategy(bytes32 strategyId,uint256 nonce,uint256 deadline)");

    /// @dev VaultRegistry this adapter trusts.
    address internal immutable _registry;

    /// @notice The 1inch Aqua protocol contract (maker registry). Immutable.
    /// @dev This adapter is the maker: `aqua.ship` records virtual balances under `msg.sender == this`, so no
    ///      other party can author an order attributed to this adapter. Moving no tokens, ship is non-custodial.
    IAqua public immutable aqua;

    /// @notice The bound SwapVM router: passed as `app` to every Aqua call, and the ONLY address allowed to
    ///         enter the maker hooks. Immutable; rotate by deploying a new adapter.
    /// @dev The constructor asserts this router's own immutable `AQUA()` equals `aqua`, and that its EIP-712
    ///      name is one of the two accepted names above. It is NOT required to be "AquaSwapVMRouter": every
    ///      chain bound today reports "1inch SwapVM v1.0". A router that resolves balances against a different
    ///      Aqua than the one we ship into makes every swap revert in `Aqua.safeBalances`, and both bindings
    ///      are immutable, which is why the pair and not the address is the thing to assert.
    address public immutable aquaSwapVMRouter;

    /// @notice The Composer authorized to pull residual inventory back into a vault. Timelocked.
    /// @dev The only actor that can move vault-backed inventory out of the adapter (via `approveComposerReturn`
    ///      then its own return leg). Rotated only through the propose/accept timelock, never instantly.
    address public composer;

    /// @notice The pending Composer awaiting its timelock (`address(0)` when none is proposed).
    /// @dev Set by `proposeComposer`, cleared by `acceptComposer`/`cancelComposer`.
    address public pendingComposer;

    /// @notice Earliest timestamp `acceptComposer` may execute the pending swap.
    /// @dev `proposeComposer` sets this to `block.timestamp + COMPOSER_TIMELOCK`; the accept path enforces it.
    uint256 public pendingComposerEta;

    /// @notice Per-block ship counter, keyed by block number (implicitly reset each block).
    /// @dev Keying by `block.number` gives a free per-block reset with no cleanup: a new block reads zero. Both
    ///      `shipStrategy` and `reshipStrategy` increment it, so the cap bounds total fresh depth per block.
    mapping(uint256 => uint256) public shipsThisBlock;

    /// @notice Sequential per-strategist nonce. A signed action must carry the strategist's current value,
    ///         which then increments; replay across strategies, classes, and chains all fail (chainId and
    ///         verifyingContract are in the domain separator).
    mapping(address => uint256) public strategistNonces;

    /// @notice Tokens registered under a strategy id (fixed at initial ship, cleared at dock).
    /// @dev Also the liveness marker: a non-empty list means the strategy exists locally. A reship keeps this
    ///      list unchanged (only the curve bytes and reserves rotate).
    mapping(bytes32 => address[]) private _strategyTokens;

    /// @notice Live Aqua hash for a stable strategy id; zero when docked or never shipped.
    /// @dev The forward index paired with `_strategyIdByAquaHash`. A hook only accepts an order hash that both
    ///      resolves to a strategy AND equals that strategy's current value here, so a stale (reshipped/docked)
    ///      hash is inert.
    mapping(bytes32 => bytes32) private _currentAquaHash;

    /// @notice Reverse index: live Aqua hash (== the router's `orderHash`) -> stable strategy id.
    /// @dev The hooks receive an `orderHash`, not a strategy id; this is what binds an inbound hook to a
    ///      strategy this adapter shipped. Cleared on dock/reship/force-clear so a stale hash is inert.
    mapping(bytes32 => bytes32) private _strategyIdByAquaHash;

    /// @notice The vault consent class funding a strategy. Shared across the strategy's tokens.
    /// @dev One class per strategy: every token's vault must agree on the class strategist, so a class is a
    ///      single consent unit and the maker hooks source each leg against this same class.
    mapping(bytes32 => uint256) private _strategyClassId;

    /// @notice Declared maker-fee rate per strategy, in PARTS PER BILLION (1e9 == 100%). NOT basis points.
    /// @dev Named for its unit deliberately. The router's denomination is 1e9 while this repo's own vault
    ///      parameters are 10_000-denominated, so a bare "bps" is ambiguous between two live conventions and
    ///      resolves the wrong way for anyone who has met basis points before: a rate written as 30 would be
    ///      0.000003%, a fee ~333,000x too small that ships, swaps and settles without reverting.
    ///      Zero means no declared rate, which is every strategy shipped through the fee-less selector.
    mapping(bytes32 => uint32) public strategyFeePpb;

    /// @dev RAY (1e27) fixed-point unit for the settle-seam reference price. The reference price passed to
    ///      `settleVenueCredit` is the executed ratio `received * RAY / amountOut`, where `received` is the IN
    ///      leg's MEASURED receipt, so proceeds are credited at the price the swap actually executed at. The
    ///      numerator is the measurement rather than the declared `amountIn` because the two diverge for a
    ///      fee-on-transfer `tokenIn`, and pricing the declared amount values proceeds the vault never got.
    uint256 private constant RAY = 1e27;

    // ---- Swap-scoped buffer to thread the sourcing allocation across the two maker hooks ----
    //
    // The two hooks (`preTransferOut` = OUT leg, `postTransferIn` = IN leg) run in taker-chosen order within one
    // reentrancy-guarded swap. Whichever runs SECOND performs the counter vault's `settleVenueCredit` with the
    // OUT leg's `Alloc[]`, so a single-sided LP's proceeds are attributed to them. One swap at a time
    // (the router does not interleave hooks across swaps), so a single buffer suffices; it is cleared on credit.
    // Keyed by `_swapOrderHash` with an assert-match on close: if a router ever DID interleave two orders'
    // hooks (`OUT(A) -> OUT(B) -> IN(A) -> IN(B)`), the closing leg's `orderHash` would not match the
    // buffered one and the swap reverts, rather than crediting order B's proceeds to order A's sellers.
    Alloc[] private _swapAlloc; // the OUT leg's sourcing allocation
    uint256 private _swapClassId;
    uint256 private _swapOutAmount; // OUT leg amountOut (for the executed-ratio refPrice)
    address private _swapInVault; // IN leg's vault
    uint256 private _swapInReceived; // IN leg's measured receipt (approved, not yet credited)
    uint256 private _swapInAmount; // IN leg amountIn
    bytes32 private _swapOrderHash; // the order whose leg opened the buffer; the closing leg must match it
    bool private _swapOutPending; // OUT leg ran, awaiting the IN leg to credit
    bool private _swapInPending; // IN leg ran first, awaiting the OUT leg to credit

    /// @notice Per-strategy per-token shipped virtual reserve. Reporting + reship + token membership; it
    ///         reserves nothing, because nothing is held.
    /// @dev A non-zero entry is ALSO the token-membership check the maker hooks use (`_requireLiveOrder`): a
    ///      hook leg can only touch a token whose reserve here is > 0.
    mapping(bytes32 => mapping(address => uint256)) private _strategyAmounts;

    /// @notice Whether a token currently backs a live strategy (the one-strategy-per-token gate).
    mapping(address => bool) private _tokenHasLiveStrategy;

    /// @notice When true, at most one live strategy may back a token.
    /// @dev Not an allowance-safety guard (there is no standing allowance to corrupt). It is an exposure
    ///      knob: two strategies on one token can jointly quote more depth than the vault class can fund, so
    ///      the second swap of a block reverts. Admin toggle, on by default. Even when off, the vault's
    ///      own-idle debit in `settleVenueOut` still backstops every pull, so this only tunes exposure.
    bool public oneStrategyPerToken = true;

    /// @dev Operator gate: holds `OPERATOR_ROLE` AND is an EOA.
    modifier onlyOperator() {
        _checkRole(Roles.OPERATOR_ROLE);
        require(msg.sender == tx.origin, Errors.OperatorMustBeEOA());
        _;
    }

    /// @dev Only the bound router may enter the maker hooks. They are public and move vault capital; this is
    ///      the check that stops anyone else draining a vault through them.
    modifier onlyRouter() {
        require(msg.sender == aquaSwapVMRouter, Errors.HookCallerNotRouter(msg.sender));
        _;
    }

    /// @param admin     Receives `DEFAULT_ADMIN_ROLE` (operator rotation, emergency, risk toggle).
    /// @param operator  Receives `OPERATOR_ROLE` (relays the strategist-signed lifecycle, pays gas).
    /// @param guardian  Receives `GUARDIAN_ROLE` (the pause-only key that may `emergencyDock` a strategy).
    /// @param registry_ The VaultRegistry this adapter trusts.
    /// @param composer_ The Composer authorized to pull residual inventory back to a vault.
    /// @param aqua_     The 1inch Aqua protocol contract.
    /// @param router_   The canonical AquaSwapVMRouter (`app`, and the sole hook caller).
    /// @param domainVersion The EIP-712 domain version; `"1"` on mainnet, a distinct value on a fork so a
    ///                      fork-minted signature cannot validate against the mainnet deployment. Empty is
    ///                      refused, since it is what an omitted argument passes.
    constructor(
        address admin,
        address operator,
        address guardian,
        address registry_,
        address composer_,
        IAqua aqua_,
        address router_,
        string memory domainVersion
    ) {
        require(
            admin != address(0) && operator != address(0) && guardian != address(0) && registry_ != address(0)
                && composer_ != address(0) && address(aqua_) != address(0) && router_ != address(0),
            Errors.ZeroAddress()
        );
        require(bytes(domainVersion).length != 0, Errors.EmptyDomainVersion());
        DOMAIN_VERSION_HASH = keccak256(bytes(domainVersion));

        // Both bindings are immutable, so a mismatch is a redeploy; and it would revert every swap. Ask the
        // router which Aqua it binds and what it calls itself; never assume.
        // (1) A router that resolves balances against a different Aqua than the one we ship into makes every
        //     swap revert in `Aqua.safeBalances`.
        address routerAqua = ISwapVMRouter(router_).AQUA();
        require(routerAqua == address(aqua_), Errors.RouterAquaMismatch(routerAqua, address(aqua_)));
        // (2) The router's EIP-712 name must be one of the accepted SwapVM builds, so a look-alike router
        //     cannot be bound as the sole hook caller. This is a look-alike FILTER only; the load-bearing
        //     safety is (1) above (`router.AQUA() == aqua`), which guarantees the adapter ships into the exact
        //     Aqua this router reads at swap time. Accepting a second verified build therefore cannot bind a
        //     router that resolves balances against a different Aqua.
        (, string memory routerName,,,,,) = IERC5267(router_).eip712Domain();
        bytes32 routerNameHash = keccak256(bytes(routerName));
        require(
            routerNameHash == EXPECTED_ROUTER_NAME_HASH || routerNameHash == EXPECTED_ROUTER_NAME_HASH_V1,
            Errors.RouterNotAquaRouter(routerName)
        );

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.OPERATOR_ROLE, operator);
        _grantRole(Roles.GUARDIAN_ROLE, guardian);
        _registry = registry_;
        composer = composer_;
        aqua = aqua_;
        aquaSwapVMRouter = router_;
    }

    // ============================================================
    // IVenueAdapter
    // ============================================================

    /// @inheritdoc IVenueAdapter
    /// @dev Constant true; the registry calls this at allowlist time to confirm the contract is a real adapter.
    function isVenueAdapter() external pure returns (bool) {
        return true;
    }

    /// @inheritdoc IVenueAdapter
    /// @dev `keccak256("Aqua")`; distinguishes this venue from V4 in registry and event data.
    function venueId() external pure returns (bytes32) {
        return VENUE_ID;
    }

    /// @inheritdoc IVenueAdapter
    /// @dev The registry checks this equals itself before allowlisting, so a foreign-bound adapter is never
    ///      trusted by a registry it does not name.
    function registry() external view returns (address) {
        return _registry;
    }

    /// @inheritdoc IVenueAdapter
    /// @dev `OperatorDriven`: an operator relays the strategist-signed lifecycle (ship/reship/dock); the venue
    ///      itself does not call back into the adapter except through the maker hooks mid-swap.
    function triggerModel() external pure returns (TriggerModel) {
        return TriggerModel.OperatorDriven;
    }

    /// @inheritdoc IVenueAdapter
    /// @dev `SettlementReported`: PnL is reconciled off-chain from the reconcile events, not priced on-chain.
    function valuationModel() external pure returns (ValuationModel) {
        return ValuationModel.SettlementReported;
    }

    // ============================================================
    // Strategy lifecycle (operator)
    // ============================================================

    /// @notice Ship a strategy to Aqua. Moves no tokens; capital stays idle in each token's vault until a
    ///         swap pulls it just-in-time.
    /// @dev Order of operations is security-relevant: bound the per-block ship count, validate the order bytes
    ///      and commit/back the tokens, THEN verify the strategist signature over the exact (class, curve,
    ///      tokens, reserves), and only then call `aqua.ship`. The returned Aqua hash must equal the local
    ///      `strategyId` (keccak of the same bytes), which ties this adapter's reverse index to Aqua's ledger.
    /// @param classId       The vault consent class that funds this strategy on every one of its tokens.
    /// @param strategyBytes `abi.encode(ISwapVMRouter.Order)`; `strategyId = keccak256(strategyBytes)`.
    /// @param tokens        Token list (non-empty, no zeros, no duplicates, <= `MAX_STRATEGY_TOKENS`).
    /// @param amounts       Per-token virtual reserve (> 0), each <= that token's vault idle for `classId`.
    /// @return strategyId   Stable id (keccak256 of the initial bytes).
    /// @param nonce         The signing strategist's current sequential nonce.
    /// @param deadline      Signature expiry (unix seconds).
    /// @param strategistSig The class strategist's EIP-712 signature over `ShipStrategy(...)` (ERC-1271-aware).
    function shipStrategy(
        uint256 classId,
        bytes calldata strategyBytes,
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256 nonce,
        uint256 deadline,
        bytes calldata strategistSig
    ) external onlyOperator nonReentrant returns (bytes32 strategyId) {
        return _shipStrategy(classId, strategyBytes, tokens, amounts, 0, false, nonce, deadline, strategistSig);
    }

    /// @notice `shipStrategy`, with the strategy's maker-fee rate DECLARED and covered by the signature.
    /// @dev The rate is declared rather than parsed out of the program: the adapter does not read opcodes, and
    ///      deriving a fair price needs the rate. A strategist who declares a rate their program does not
    ///      charge shifts the composition/fee split but cannot mint - the backing cap still bounds every credit
    ///      to the physical receipt - which is the same property that already makes a dishonest reference price
    ///      safe.
    ///
    ///      `feePpb` is PARTS PER BILLION: 1e9 == 100%. 30 bps is 3_000_000, not 30.
    /// @param feePpb The declared rate in parts per billion; bounded by `MAX_FEE_PPB`.
    function shipStrategyWithFee(
        uint256 classId,
        bytes calldata strategyBytes,
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint32 feePpb,
        uint256 nonce,
        uint256 deadline,
        bytes calldata strategistSig
    ) external onlyOperator nonReentrant returns (bytes32 strategyId) {
        return _shipStrategy(classId, strategyBytes, tokens, amounts, feePpb, true, nonce, deadline, strategistSig);
    }

    function _shipStrategy(
        uint256 classId,
        bytes calldata strategyBytes,
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint32 feePpb,
        bool feeDeclared,
        uint256 nonce,
        uint256 deadline,
        bytes calldata strategistSig
    ) private returns (bytes32 strategyId) {
        require(feePpb <= MAX_FEE_PPB, Errors.FeeRateOutOfRange(feePpb, MAX_FEE_PPB));
        require(strategyBytes.length > 0, Errors.EmptyStrategy());
        require(tokens.length > 0 && tokens.length <= MAX_STRATEGY_TOKENS, Errors.LengthMismatch());
        require(tokens.length == amounts.length, Errors.LengthMismatch());

        // The stable id IS the keccak of the curve bytes, so a strategy id and its curve are inseparable.
        strategyId = keccak256(strategyBytes);
        require(_strategyTokens[strategyId].length == 0, Errors.StrategyAlreadyShipped(strategyId));

        // Per-block ship cap: bounds how much fresh depth a compromised operator can quote in one block.
        _bumpShipCap();

        _validateStrategyBytes(strategyBytes);
        // Commits tokens (each backed by vault idle) AND requires all tokens' vaults agree on one strategist.
        address strategist = _commitShipTokens(strategyId, classId, tokens, amounts);
        _strategyClassId[strategyId] = classId;
        if (feePpb > 0) strategyFeePpb[strategyId] = feePpb;

        // The strategist authorized THIS ship: this class, this exact curve (strategyId), these tokens+reserves.
        bytes32 structHash = feeDeclared
            ? keccak256(
                abi.encode(
                    SHIP_STRATEGY_FEE_TYPEHASH,
                    classId,
                    strategyId,
                    keccak256(abi.encodePacked(tokens)),
                    keccak256(abi.encodePacked(amounts)),
                    feePpb,
                    nonce,
                    deadline
                )
            )
            : keccak256(
                abi.encode(
                    SHIP_STRATEGY_TYPEHASH,
                    classId,
                    strategyId,
                    keccak256(abi.encodePacked(tokens)),
                    keccak256(abi.encodePacked(amounts)),
                    nonce,
                    deadline
                )
            );
        _verifyStrategist(strategist, structHash, nonce, deadline, strategistSig);

        // Aqua takes the maker from `msg.sender`, so only this contract can author an order whose maker is
        // this contract; the returned hash must equal the local id or the shipped bytes were not what we hashed.
        bytes32 returnedHash = aqua.ship(aquaSwapVMRouter, strategyBytes, tokens, amounts);
        require(returnedHash == strategyId, Errors.AquaHashMismatch(strategyId, returnedHash));

        // Forward index (id -> live hash) and reverse index (hash -> id): the hooks resolve an inbound
        // `orderHash` through the reverse index, so setting it here is what makes the strategy swappable.
        _currentAquaHash[strategyId] = returnedHash;
        _strategyIdByAquaHash[returnedHash] = strategyId;
        emit Events.AdapterStrategyShipped(address(this), strategyId, tokens, amounts);
    }

    /// @notice Dock (deactivate) a live strategy in Aqua and report what the venue actually returned.
    /// @dev Moves no tokens. Snapshots Aqua's per-token ledger before the dock zeroes it and pairs it with the
    ///      shipped reserve in `AdapterStrategyReconciled` for off-chain PnL settlement. Requires the
    ///      strategist's signature (see `emergencyDock` for the guardian escape hatch when a key is lost). The
    ///      class capital never moves; docking only removes the Aqua curve so swaps stop routing against it.
    /// @param strategyId  The stable strategy id (must be live).
    /// @param nonce       The signing strategist's current sequential nonce.
    /// @param deadline    Signature expiry (unix seconds).
    /// @param strategistSig The class strategist's EIP-712 signature over `DockStrategy(...)` (ERC-1271-aware).
    function dockStrategy(bytes32 strategyId, uint256 nonce, uint256 deadline, bytes calldata strategistSig)
        external
        onlyOperator
        nonReentrant
    {
        require(_strategyTokens[strategyId].length > 0, Errors.StrategyUnknown(strategyId));
        bytes32 hash = _currentAquaHash[strategyId];
        require(hash != bytes32(0), Errors.StrategyNotActive(strategyId));

        address strategist = _liveStrategist(strategyId);
        bytes32 structHash = keccak256(abi.encode(DOCK_STRATEGY_TYPEHASH, strategyId, nonce, deadline));
        _verifyStrategist(strategist, structHash, nonce, deadline, strategistSig);

        (address[] memory tokens, uint256[] memory shipped, uint256[] memory venueReturned) =
            _snapshotStrategy(strategyId, hash);

        // Clear the reverse index BEFORE the external dock, so an inbound hook mid-teardown finds no live order.
        _currentAquaHash[strategyId] = bytes32(0);
        delete _strategyIdByAquaHash[hash];
        aqua.dock(aquaSwapVMRouter, hash, tokens);

        for (uint256 i; i < tokens.length; ++i) {
            _releaseToken(strategyId, tokens[i]);
        }

        delete _strategyClassId[strategyId];
        delete _strategyTokens[strategyId];
        emit Events.AdapterStrategyDocked(address(this), strategyId, hash);
        emit Events.AdapterStrategyReconciled(address(this), strategyId, tokens, shipped, venueReturned);
    }

    /// @notice Rotate a strategy's bytecode under the same stable `strategyId` (dock old, ship new).
    /// @dev The token list and the funding class are fixed at the initial ship. New reserves are re-checked
    ///      against vault backing exactly as a fresh ship is. Gating ship alone would leave this door open ; an
    ///      attacker could replace a live curve; so reship carries the strategist's signature too. Counts
    ///      against the per-block ship cap because it ships a new curve.
    /// @param strategyId      The stable id of the live strategy to rotate.
    /// @param newStrategyBytes `abi.encode(ISwapVMRouter.Order)` of the replacement curve (non-empty; must hash
    ///                        to a value different from the current Aqua hash).
    /// @param newAmounts      Per-token virtual reserve for the new curve; length equals the fixed token list,
    ///                        each > 0 and within its vault's backing.
    /// @param nonce           The signing strategist's current sequential nonce.
    /// @param deadline        Signature expiry (unix seconds).
    /// @param strategistSig   The class strategist's EIP-712 signature over `ReshipStrategy(...)`.
    /// @return newAquaHash    The new live Aqua hash (keccak256 of `newStrategyBytes`).
    function reshipStrategy(
        bytes32 strategyId,
        bytes calldata newStrategyBytes,
        uint256[] calldata newAmounts,
        uint256 nonce,
        uint256 deadline,
        bytes calldata strategistSig
    ) external onlyOperator nonReentrant returns (bytes32 newAquaHash) {
        require(newStrategyBytes.length > 0, Errors.EmptyStrategy());

        _bumpShipCap();

        require(_strategyTokens[strategyId].length > 0, Errors.StrategyUnknown(strategyId));
        require(newAmounts.length == _strategyTokens[strategyId].length, Errors.LengthMismatch());

        bytes32 oldAquaHash = _currentAquaHash[strategyId];
        require(oldAquaHash != bytes32(0), Errors.StrategyNotActive(strategyId));

        // Aqua enforces strategy immutability after a dock, so a reship MUST hash to a new curve; identical
        // bytes would collide with the docked hash and fail at Aqua.
        newAquaHash = keccak256(newStrategyBytes);
        require(newAquaHash != oldAquaHash, Errors.ReshipBytesIdentical());

        _validateStrategyBytes(newStrategyBytes);

        address strategist = _liveStrategist(strategyId);
        bytes32 structHash = keccak256(
            abi.encode(
                RESHIP_STRATEGY_TYPEHASH,
                strategyId,
                newAquaHash,
                keccak256(abi.encodePacked(newAmounts)),
                nonce,
                deadline
            )
        );
        _verifyStrategist(strategist, structHash, nonce, deadline, strategistSig);

        // Snapshot the token list (the storage ref does not survive aqua.dock) with the shipped reserve and
        // Aqua's live per-token inventory.
        (address[] memory tokens, uint256[] memory shipped, uint256[] memory venueReturned) =
            _snapshotStrategy(strategyId, oldAquaHash);

        // Re-check every new reserve against current vault backing exactly as a fresh ship does.
        uint256 classId = _strategyClassId[strategyId];
        for (uint256 i; i < tokens.length; ++i) {
            require(newAmounts[i] > 0, Errors.ZeroAmount());
            _requireVaultBacks(tokens[i], classId, newAmounts[i]);
            _strategyAmounts[strategyId][tokens[i]] = newAmounts[i];
        }

        // Rotate the indices to the new hash BEFORE the external dock/ship, so no window exposes the old hash.
        _currentAquaHash[strategyId] = newAquaHash;
        delete _strategyIdByAquaHash[oldAquaHash];
        _strategyIdByAquaHash[newAquaHash] = strategyId;

        // Dock the old curve, then ship the new one; the returned hash must match what we indexed.
        aqua.dock(aquaSwapVMRouter, oldAquaHash, tokens);

        bytes32 returnedHash = aqua.ship(aquaSwapVMRouter, newStrategyBytes, tokens, newAmounts);
        require(returnedHash == newAquaHash, Errors.AquaHashMismatch(newAquaHash, returnedHash));

        emit Events.AdapterStrategyReshipped(address(this), strategyId, oldAquaHash, newAquaHash, newAmounts);
        emit Events.AdapterStrategyReconciled(address(this), strategyId, tokens, shipped, venueReturned);
    }

    // ============================================================
    // IMakerHooks; the just-in-time seam. Entered ONLY by `aquaSwapVMRouter`, mid-swap.
    // ============================================================

    /// @inheritdoc IMakerHooks
    /// @dev Fires immediately before `Aqua.pull` executes `tokenOut.transferFrom(this, taker, amountOut)`.
    ///      Sources the shortfall from `tokenOut`'s vault and approves Aqua exactly `amountOut`. Reverting
    ///      reverts the swap.
    function preTransferOut(
        address maker,
        address, /* taker */
        address, /* tokenIn */
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 orderHash,
        bytes calldata, /* makerData */
        bytes calldata /* takerData: taker-controlled, never read */
    ) external onlyRouter nonReentrant {
        bytes32 strategyId = _requireLiveOrder(maker, orderHash, tokenOut);
        // Reject a zero-out OUT leg. Both maker hooks fire for every swap (traits-pinned) and the settle buffer
        // is threaded across the two by a pending flag cleared only on the paired credit. A degenerate half-swap
        // (one non-zero leg) must NOT early-return past that clear, or it leaves the buffer latched for the NEXT
        // swap to consume (cross-swap mis-attribution / venue DoS). Reverting rolls back atomically, so the buffer
        // is only ever persisted across the two hooks of a single complete swap and always cleared by the closer.
        require(amountOut > 0, Errors.EmptySwapLeg());
        uint256 classId = _strategyClassId[strategyId];

        // Source the FULL `amountOut` from committers every time, never netted against any residual balance
        // the adapter happens to hold. The JIT design keeps the adapter at zero balance at rest between
        // swaps, so a nonzero balance here is exactly a donation (permissionless `Aqua.push`-adjacent raw
        // transfer) or dust - either way, netting it against the source would shrink `alloc.drawn` below
        // `amountOut` while the counter leg's `refPriceRay` (= amountIn/amountOut, in the caller below)
        // stays priced against the FULL notional, letting a donor capture the undrawn portion's counter-value
        // as freely-withdrawable credit via `creditFromSwap`. Sourcing
        // the full amount keeps `alloc.drawn == amountOut` always, so pricing and sourcing never diverge.
        // `settleVenueOut` is the authoritative pull-time backstop: it debits the class's own idle
        // (INV-GLOBAL) and is metered, so an over-shipped reserve reverts here rather than settling unbacked.
        // The returned `Alloc[]` names WHO sold how much, which is what lets the counter leg attribute
        // proceeds back to the sellers.
        Alloc[] memory alloc = IAssetVault(_vaultFor(tokenOut)).settleVenueOut(classId, address(this), amountOut);

        // Approve Aqua EXACTLY `amountOut`, consumed to zero by the pull that runs next. No standing allowance
        // ever exists, so a later spurious pull has nothing to draw on.
        IERC20(tokenOut).forceApprove(address(aqua), amountOut);

        if (_swapInPending) {
            // The IN leg already ran and deferred: this OUT leg is the closer. Assert it closes the SAME
            // order the IN leg opened the buffer for - a mismatch means the router interleaved two orders'
            // hooks, and crediting here would attribute order B's sellers with order A's proceeds.
            require(orderHash == _swapOrderHash, Errors.SwapOrderMismatch(_swapOrderHash, orderHash));
            // Credit the IN receipt to THESE sellers at the executed ratio, then drop the IN leg's leftover
            // approval and clear the buffer so the next swap starts clean. Price off `_swapInReceived` (what
            // the IN leg MEASURED) rather than the declared `amountIn`: for a fee-on-transfer tokenIn the two
            // differ, and pricing the declared amount values the sellers' proceeds above what the vault
            // actually holds, which `creditFromSwap`'s backing cap then rejects as `BackingCapExceeded` - an
            // error naming the wrong cause, on a path this adapter otherwise measures for FOT throughout.
            uint256 refPriceRay = Math.mulDiv(_swapInReceived, RAY, amountOut);
            IAssetVault(_swapInVault).settleVenueCredit(classId, _swapInReceived, alloc, refPriceRay);
            IERC20(_swapInVaultAsset()).forceApprove(_swapInVault, 0);
            _clearSwap();
        } else {
            // OUT leg ran first: buffer the allocation and the amounts for the IN leg (running later) to credit.
            _swapOrderHash = orderHash;
            _setSwapAlloc(alloc);
            _swapClassId = classId;
            _swapOutAmount = amountOut;
            _swapInAmount = amountIn;
            _swapOutPending = true;
        }
    }

    /// @inheritdoc IMakerHooks
    /// @dev Fires immediately after `Aqua.push` deposited `amountIn` of `tokenIn` into this adapter. Aqua
    ///      forbids a custom receiver, so this hook is the only way the inflow reaches its vault.
    function postTransferIn(
        address maker,
        address, /* taker */
        address tokenIn,
        address, /* tokenOut */
        uint256 amountIn,
        uint256, /* amountOut */
        bytes32 orderHash,
        bytes calldata, /* makerData */
        bytes calldata /* takerData: taker-controlled, never read */
    ) external onlyRouter nonReentrant {
        bytes32 strategyId = _requireLiveOrder(maker, orderHash, tokenIn);
        // Reject a zero-in IN leg. See `preTransferOut`: a degenerate half-swap must revert rather than
        // early-return past the buffer clear, so the two-hook settle buffer can never leak across swaps.
        require(amountIn > 0, Errors.EmptySwapLeg());
        uint256 classId = _strategyClassId[strategyId];

        // Sweep what actually arrived (a fee-on-transfer tokenIn delivers less), capped at `amountIn`.
        uint256 held = IERC20(tokenIn).balanceOf(address(this));
        uint256 sweep = amountIn > held ? held : amountIn;
        // Nothing landed (a 100%-fee tokenIn): there are no proceeds to credit. Revert atomically rather than
        // early-return with the buffer half-set.
        require(sweep > 0, Errors.EmptySwapLeg());

        // Approve the vault to pull exactly what landed; `settleVenueCredit` (below or on the OUT leg) draws it.
        address vault = _vaultFor(tokenIn);
        IERC20(tokenIn).forceApprove(vault, sweep);

        if (_swapOutPending) {
            // The OUT leg already ran: this IN leg is the closer. Assert it closes the SAME order the OUT
            // leg opened the buffer for - a mismatch means the router interleaved two orders' hooks, and
            // crediting here would attribute order A's sellers with order B's proceeds.
            require(orderHash == _swapOrderHash, Errors.SwapOrderMismatch(_swapOrderHash, orderHash));
            // Credit these proceeds to the OUT leg's sourcing sellers at the executed ratio, revoke the
            // approval, clear. Price off `sweep` (what actually landed) rather than the declared `amountIn`:
            // they diverge exactly when tokenIn charges a transfer fee, and pricing the declared amount
            // values proceeds the vault never received. See the sibling site in `preTransferOut`.
            uint256 refPriceRay = Math.mulDiv(sweep, RAY, _swapOutAmount);
            IAssetVault(vault).settleVenueCredit(classId, sweep, _swapAlloc, refPriceRay);
            IERC20(tokenIn).forceApprove(vault, 0);
            _clearSwap();
        } else {
            // OUT leg has not run yet: defer the credit to it (it holds the allocation). Leave the approval set
            // so the OUT leg's `settleVenueCredit` against `_swapInVault` can still pull `sweep`.
            _swapOrderHash = orderHash;
            _swapInVault = vault;
            _swapInReceived = sweep;
            _swapInAmount = amountIn;
            _swapInPending = true;
        }
    }

    /// @dev The asset of the vault the IN leg deferred against, used to clear the leftover approval when the
    ///      OUT leg closes a swap whose IN leg ran first.
    /// @return The underlying asset of `_swapInVault`.
    function _swapInVaultAsset() private view returns (address) {
        return IAssetVault(_swapInVault).asset();
    }

    /// @dev Copy the OUT leg's memory allocation into the swap-scoped storage buffer so the IN leg (running
    ///      later, in a separate call frame) can credit against it. Overwrites any prior contents first.
    /// @param alloc The per-committer sourcing allocation the OUT leg produced.
    function _setSwapAlloc(Alloc[] memory alloc) private {
        delete _swapAlloc;
        for (uint256 i; i < alloc.length; ++i) {
            _swapAlloc.push(alloc[i]);
        }
    }

    /// @dev Clear the swap-scoped buffer after a credit completes. Resetting BOTH pending flags is what lets
    ///      the next swap start clean; a leaked flag would mis-attribute the following swap.
    function _clearSwap() private {
        delete _swapAlloc;
        _swapClassId = 0;
        _swapOutAmount = 0;
        _swapInVault = address(0);
        _swapInReceived = 0;
        _swapInAmount = 0;
        _swapOrderHash = bytes32(0);
        _swapOutPending = false;
        _swapInPending = false;
    }

    /// @inheritdoc IMakerHooks
    /// @dev Not enabled. `_validateStrategyBytes` refuses any order carrying `TRAIT_PRE_TRANSFER_IN`, so the
    ///      router never calls this on a strategy this adapter shipped. It reverts (rather than no-ops) so that
    ///      a mis-encoded traits word surfaces loudly instead of silently skipping a settlement leg. Still
    ///      `onlyRouter`, so an outsider cannot even reach the revert.
    function preTransferIn(
        address,
        address,
        address,
        address,
        uint256,
        uint256,
        bytes32,
        bytes calldata,
        bytes calldata
    ) external view onlyRouter {
        revert Errors.HookNotEnabled();
    }

    /// @inheritdoc IMakerHooks
    /// @dev Not enabled; `TRAIT_POST_TRANSFER_OUT` is refused at ship time. Reverts for the same reason as
    ///      `preTransferIn`: a strategy that reached this hook was mis-encoded, and failing loud is safer than
    ///      settling a swap through an unimplemented leg.
    function postTransferOut(
        address,
        address,
        address,
        address,
        uint256,
        uint256,
        bytes32,
        bytes calldata,
        bytes calldata
    ) external view onlyRouter {
        revert Errors.HookNotEnabled();
    }

    // ============================================================
    // Residual-inventory egress (donations, dust, airdrops)
    // ============================================================

    /// @notice Grant the Composer a bounded approval to pull `amount` of a vault-backed `token` home to its
    ///         vault. The only egress for vault-backed inventory. Pass `amount == 0` to revoke.
    /// @dev `token` must have a registry vault; a vault-less token is unpullable by the Composer's return leg.
    ///      The approval is bounded by the balance actually held, so it can never over-promise. Vault-backed
    ///      tokens travel ONLY adapter -> Composer -> vault, never anywhere else.
    /// @param token  A vault-backed token to authorize the Composer to reclaim.
    /// @param amount The exact approval to grant (<= balance held); 0 revokes.
    function approveComposerReturn(address token, uint256 amount) external onlyOperator {
        require(IVaultRegistry(_registry).vaultForAsset(token) != address(0), Errors.TokenHasNoVault(token));

        uint256 held = IERC20(token).balanceOf(address(this));
        require(amount <= held, Errors.InsufficientFreeBalance(token, amount, held));

        IERC20(token).forceApprove(composer, amount);
        emit Events.AdapterComposerReturnApproved(address(this), token, amount);
    }

    /// @notice Sweep `amount` of a token that has NEVER had a registry vault; dust, an airdrop, a reward.
    /// @dev Disjoint from `approveComposerReturn`: a token either has (or once had) a vault and travels only
    ///      adapter -> Composer -> vault, or it never did and only this can move it. `isVaultedAsset` is
    ///      permanent, so an admin cannot deregister a vault to reclassify its asset as dust, and this can
    ///      never reach a token a live strategy depends on.
    /// @param token  A token that has NEVER been a vaulted asset.
    /// @param to     Recipient of the swept tokens (non-zero).
    /// @param amount Amount to sweep (> 0, <= balance held).
    function rescueUnvaultedToken(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        require(to != address(0), Errors.ZeroAddress());
        require(amount > 0, Errors.ZeroAmount());

        require(
            !IVaultRegistry(_registry).isVaultedAsset(token),
            Errors.TokenHasVault(token, IVaultRegistry(_registry).vaultForAsset(token))
        );

        uint256 held = IERC20(token).balanceOf(address(this));
        require(amount <= held, Errors.InsufficientFreeBalance(token, amount, held));

        IERC20(token).safeTransfer(to, amount);
        emit Events.AdapterTokensRescued(address(this), token, to, amount);
    }

    // ============================================================
    // Admin (emergency / risk)
    // ============================================================

    /// @notice Admin/guardian last-resort teardown of a strategy's local state, attempting `aqua.dock`
    ///         best-effort.
    /// @dev Moves no tokens. Clears the hook binding (`_strategyIdByAquaHash`) and the per-token gate even if
    ///      `aqua.dock` reverts (wrapped in try/catch), so a wedged Aqua state can never leave a token
    ///      permanently un-shippable. Use `emergencyDock` first when a clean reconcile is still possible; this
    ///      is the escape hatch when even the dock reverts. Open to the guardian as well as the admin for
    ///      incident-response symmetry with `emergencyDock` (guardian): both are containment levers that move
    ///      no tokens, and a strategy's capital always sits as idle in its vaults regardless of this call.
    /// @param strategyId The stable id of the strategy to force-clear (must have a token list).
    function emergencyClearStrategy(bytes32 strategyId) external nonReentrant {
        require(
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender) || hasRole(Roles.GUARDIAN_ROLE, msg.sender),
            Errors.NotAdminOrGuardian(msg.sender)
        );
        address[] storage tokens = _strategyTokens[strategyId];
        require(tokens.length > 0, Errors.StrategyUnknown(strategyId));

        // Clear the local indices unconditionally FIRST, so the strategy is inert even if the external dock
        // reverts below; this is what guarantees a wedged Aqua state cannot brick the token forever.
        bytes32 lastHash = _currentAquaHash[strategyId];
        _currentAquaHash[strategyId] = bytes32(0);
        if (lastHash != bytes32(0)) delete _strategyIdByAquaHash[lastHash];

        // Best-effort dock: swallow a revert (that is the whole point of this last-resort path).
        bool dockAttempted;
        if (lastHash != bytes32(0)) {
            dockAttempted = true;
            try aqua.dock(aquaSwapVMRouter, lastHash, tokens) { } catch { }
        }

        uint256 n = tokens.length;
        for (uint256 i; i < n; ++i) {
            _releaseToken(strategyId, tokens[i]);
        }

        delete _strategyClassId[strategyId];
        delete _strategyTokens[strategyId];
        emit Events.AdapterStrategyForceCleared(address(this), strategyId, lastHash, dockAttempted);
    }

    /// @notice Guardian escape hatch: dock a live strategy WITHOUT a strategist signature.
    /// @dev Ship/reship/dock all require the strategist's signature, so a lost strategist key would otherwise
    ///      leave a strategy live forever. This lets the pause-only guardian tear it down. It is not an
    ///      exfiltration path: docking moves no tokens; the class's capital always sits as idle in its
    ///      vaults, and this only zeroes the Aqua strategy so swaps stop routing against it. Emits a distinct
    ///      event so an unsigned dock is auditable apart from the normal signed one. Strict (not best-effort)
    ///      so it produces a clean reconcile; the admin `emergencyClearStrategy` remains the best-effort
    ///      last resort if `aqua.dock` itself reverts.
    /// @param strategyId The stable id of the live strategy to dock without a strategist signature.
    function emergencyDock(bytes32 strategyId) external onlyRole(Roles.GUARDIAN_ROLE) nonReentrant {
        require(_strategyTokens[strategyId].length > 0, Errors.StrategyUnknown(strategyId));
        bytes32 hash = _currentAquaHash[strategyId];
        require(hash != bytes32(0), Errors.StrategyNotActive(strategyId));

        // Snapshot before dock (Aqua zeroes its ledger on dock), then dock strictly: unlike
        // `emergencyClearStrategy`, this path expects a clean reconcile, so it does NOT swallow a dock revert.
        (address[] memory tokens, uint256[] memory shipped, uint256[] memory venueReturned) =
            _snapshotStrategy(strategyId, hash);

        _currentAquaHash[strategyId] = bytes32(0);
        delete _strategyIdByAquaHash[hash];
        aqua.dock(aquaSwapVMRouter, hash, tokens);

        for (uint256 i; i < tokens.length; ++i) {
            _releaseToken(strategyId, tokens[i]);
        }

        delete _strategyClassId[strategyId];
        delete _strategyTokens[strategyId];
        // Distinct event so an UNSIGNED (guardian) dock is auditable apart from the normal signed one.
        emit Events.AdapterStrategyEmergencyDocked(address(this), strategyId, hash);
        emit Events.AdapterStrategyReconciled(address(this), strategyId, tokens, shipped, venueReturned);
    }

    /// @notice Toggle the one-strategy-per-token exposure control (see the state-variable NatSpec).
    /// @param enabled True to allow at most one live strategy per token, false to allow several.
    function setOneStrategyPerToken(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        oneStrategyPerToken = enabled;
        emit Events.AdapterOneStrategyPerTokenSet(address(this), enabled);
    }

    // ============================================================
    // Composer rotation (timelocked; no instant swap)
    // ============================================================

    /// @notice Propose a new Composer. Takes effect only after `COMPOSER_TIMELOCK` via `acceptComposer`.
    /// @dev The Composer is the only actor that can pull residual inventory home, so its rotation is
    ///      timelocked: there is no instant swap, giving watchers a window to react to a bad proposal.
    /// @param next The proposed Composer address (non-zero).
    function proposeComposer(address next) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(next != address(0), Errors.ZeroAddress());
        pendingComposer = next;
        pendingComposerEta = block.timestamp + COMPOSER_TIMELOCK;
        emit Events.AdapterComposerProposed(address(this), next, pendingComposerEta);
    }

    /// @notice Execute the pending Composer swap once its timelock has elapsed.
    /// @dev Reverts if nothing is pending or the ETA has not passed, so a swap can never skip the delay.
    function acceptComposer() external onlyRole(DEFAULT_ADMIN_ROLE) {
        address next = pendingComposer;
        require(next != address(0), Errors.NoPendingComposerProposal());
        require(
            block.timestamp >= pendingComposerEta, Errors.ComposerProposalNotReady(pendingComposerEta, block.timestamp)
        );

        address previous = composer;
        composer = next;
        pendingComposer = address(0);
        pendingComposerEta = 0;
        emit Events.AdapterComposerSet(address(this), previous, next);
    }

    /// @notice Cancel a pending Composer swap before it is accepted.
    /// @dev Lets the admin abandon a proposal (for example a typo'd address) without waiting out the timelock.
    function cancelComposer() external onlyRole(DEFAULT_ADMIN_ROLE) {
        address pending = pendingComposer;
        require(pending != address(0), Errors.NoPendingComposerProposal());
        pendingComposer = address(0);
        pendingComposerEta = 0;
        emit Events.AdapterComposerProposalCancelled(address(this), pending);
    }

    // ============================================================
    // Views
    // ============================================================

    /// @notice The token list fixed at the initial ship (empty if never shipped or docked).
    /// @param strategyId The stable strategy id to query.
    /// @return The strategy's token list, or an empty array if it is not live.
    function getStrategyTokens(bytes32 strategyId) external view returns (address[] memory) {
        return _strategyTokens[strategyId];
    }

    /// @notice Aqua's own remaining virtual inventory for `token` under a live strategy. Zero once docked.
    /// @dev Reads Aqua's ledger directly rather than this adapter's shipped figure, so it reflects trading.
    /// @param strategyId The stable strategy id.
    /// @param token      The token whose remaining virtual balance is read.
    /// @return The live virtual reserve Aqua still holds for the token (0 if the strategy is docked).
    function strategyInventory(bytes32 strategyId, address token) external view returns (uint256) {
        bytes32 hash = _currentAquaHash[strategyId];
        if (hash == bytes32(0)) return 0;
        (uint248 balance,) = aqua.rawBalances(address(this), aquaSwapVMRouter, hash, token);
        return uint256(balance);
    }

    /// @notice The live Aqua hash for a strategy (zero if docked or never shipped).
    /// @param strategyId The stable strategy id.
    /// @return The current Aqua hash, or zero if not live.
    function currentAquaHash(bytes32 strategyId) external view returns (bytes32) {
        return _currentAquaHash[strategyId];
    }

    /// @notice The stable strategy id an order hash belongs to (zero if not live here).
    /// @dev This is the reverse index the maker hooks use to bind an inbound `orderHash` to a shipped strategy.
    /// @param orderHash The Aqua order hash (equals the live Aqua hash).
    /// @return The stable strategy id, or zero if no live strategy owns the hash.
    function strategyIdForOrder(bytes32 orderHash) external view returns (bytes32) {
        return _strategyIdByAquaHash[orderHash];
    }

    /// @notice The vault consent class funding a strategy (zero if not live).
    /// @param strategyId The stable strategy id.
    /// @return The consent class id that funds the strategy, or zero if not live.
    function strategyClassId(bytes32 strategyId) external view returns (uint256) {
        return _strategyClassId[strategyId];
    }

    /// @notice Shipped virtual reserve for a token within a strategy (zero if not live).
    /// @param strategyId The stable strategy id.
    /// @param token      The token whose shipped reserve is read.
    /// @return The reserve this adapter shipped for the token (0 if not part of a live strategy).
    function strategyAmount(bytes32 strategyId, address token) external view returns (uint256) {
        return _strategyAmounts[strategyId][token];
    }

    /// @notice Whether a token currently backs a live strategy (the one-strategy-per-token gate).
    /// @param token The token to query.
    /// @return True if a live strategy currently references the token.
    function tokenHasLiveStrategy(address token) external view returns (bool) {
        return _tokenHasLiveStrategy[token];
    }

    /// @notice The adapter's balance of `token`; all of it is free (nothing is held between swaps).
    /// @dev Non-custodial at rest, so any balance here is stray inventory (dust, a donation, an airdrop).
    /// @param token The token to read.
    /// @return The adapter's full balance of the token.
    function freeBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    // ============================================================
    // Internals
    // ============================================================

    /// @dev Bind an inbound hook to a live strategy this adapter shipped, and to one of its tokens. A taker
    ///      cannot forge `orderHash`: only this contract can author an order whose maker is this contract, so
    ///      the `maker == address(this)` + reverse-index checks are sufficient. Reverting here reverts the
    ///      swap, so a hostile order can never reach the vault-sourcing code below it.
    /// @param maker     The maker Aqua reports for the order (must be this adapter).
    /// @param orderHash The Aqua order hash presented by the router (must map to a live strategy).
    /// @param token     The leg's token (must be a member of that strategy).
    /// @return The resolved stable strategy id.
    function _requireLiveOrder(address maker, bytes32 orderHash, address token) internal view returns (bytes32) {
        // Maker must be this adapter: Aqua sets it from the shipper, so no other party can author such an order.
        require(maker == address(this), Errors.HookMakerMismatch(maker));

        // The order hash must resolve through the reverse index to a strategy whose CURRENT hash is this one;
        // a stale hash (post dock/reship) resolves to zero or a different current hash and is rejected.
        bytes32 strategyId = _strategyIdByAquaHash[orderHash];
        require(
            strategyId != bytes32(0) && _currentAquaHash[strategyId] == orderHash, Errors.HookUnknownOrder(orderHash)
        );
        // The leg's token must be a member of that strategy, so a hook can only ever touch a shipped token.
        require(_strategyAmounts[strategyId][token] > 0, Errors.HookTokenNotInStrategy(strategyId, token));

        return strategyId;
    }

    /// @dev The registry vault for `token`. Reverts rather than settling against address(0), so a mid-swap
    ///      source/sweep never silently targets the zero address.
    /// @param token The token to resolve.
    /// @return vault The token's registered vault (guaranteed non-zero).
    function _vaultFor(address token) internal view returns (address vault) {
        vault = IVaultRegistry(_registry).vaultForAsset(token);
        require(vault != address(0), Errors.TokenHasNoVault(token));
    }

    /// @dev Ship-time backing check. `Aqua.ship` escrows nothing, so a shipped reserve must not exceed what
    ///      its vault strategy can fund at pull time. This is a BOUND, NOT A RESERVATION: it does not decrement
    ///      idle, so two strategies may each pass against the same shared idle. That is intended; the vault's
    ///      own-idle debit in `settleVenueOut` (INV-GLOBAL) and its rolling outflow meter are the real pull-time
    ///      gates, and this check only rejects the obvious over-ship at authoring time. Under the shared-pool
    ///      model the per-class idle view is retired, so this reads `availableFor` (shared idle bounded by the
    ///      strategy's remaining backing) instead of the old `idleAssets(classId)`.
    /// @param token   The token whose vault backing is checked.
    /// @param classId The consent class funding the strategy.
    /// @param amount  The shipped reserve to validate against current backing.
    function _requireVaultBacks(address token, uint256 classId, uint256 amount) internal view {
        address vault = _vaultFor(token);
        require(IAssetVault(vault).classExists(classId), Errors.StrategyClassUnknown(classId));
        uint256 avail = IAssetVault(vault).availableFor(classId);
        require(amount <= avail, Errors.ShipExceedsVaultBacking(token, classId, amount, avail));
    }

    /// @dev Count this block's ship-equivalent call and enforce the per-block cap. Bounds how much fresh depth
    ///      a compromised operator can quote in one block; a zero-arg guard shared by `shipStrategy` and
    ///      `reshipStrategy` so both increment and revert on the exact same counter and error.
    function _bumpShipCap() private {
        shipsThisBlock[block.number] += 1;
        require(
            shipsThisBlock[block.number] <= MAX_SHIPS_PER_BLOCK,
            Errors.ShipsPerBlockCapExceeded(shipsThisBlock[block.number], MAX_SHIPS_PER_BLOCK)
        );
    }

    /// @dev Decode the shipped order and refuse anything that would break or redirect the seam. This is the
    ///      gate that guarantees every live curve fires BOTH maker hooks on the maker itself; a curve that
    ///      skipped `preTransferOut` would let a taker pull `tokenOut` the vault never sourced, and one that
    ///      redirected a hook off the maker would bypass the vault entirely. `maker == address(this)` also
    ///      guarantees the order this adapter is about to ship cannot be attributed to another maker.
    /// @param strategyBytes `abi.encode(ISwapVMRouter.Order)` to validate before shipping.
    function _validateStrategyBytes(bytes calldata strategyBytes) internal view {
        ISwapVMRouter.Order memory order = abi.decode(strategyBytes, (ISwapVMRouter.Order));
        require(order.maker == address(this), Errors.StrategyMakerMismatch(order.maker));

        uint256 traits = order.traits;
        bool ok = (traits & REQUIRED_TRAITS) == REQUIRED_TRAITS; // Aqua order, both JIT hooks armed
        ok = ok && (traits & (TRAIT_PRE_TRANSFER_IN | TRAIT_POST_TRANSFER_OUT)) == 0; // no hook we do not implement
        ok = ok && (traits & TRAIT_HOOK_TARGET_BITS) == 0; // no hook redirected off the maker
        ok = ok && (traits & TRAIT_SHOULD_UNWRAP_WETH) == 0; // Aqua forbids unwrap
        uint160 receiver = uint160(traits & TRAIT_RECEIVER_MASK);
        ok = ok && (receiver == 0 || address(receiver) == address(this)); // Aqua forbids a custom receiver

        require(ok, Errors.InvalidStrategyTraits(traits));
    }

    /// @dev Validate + register every token of a fresh ship, checking each shipped reserve against vault
    ///      backing. No transfers, no allowances, no reservations; `Aqua.ship` moves nothing. Returns the
    ///      class strategist, requiring every token's vault to agree on one (a class is one consent unit, so a
    ///      per-vault strategist mismatch is a misconfiguration). Rejects the zero address, duplicate tokens,
    ///      zero reserves, and (when the exposure knob is on) a token that already backs a live strategy.
    /// @param strategyId The stable id being shipped under.
    /// @param classId    The consent class funding the ship.
    /// @param tokens     The strategy's tokens (validated in place).
    /// @param amounts    The per-token shipped reserves (parallel to `tokens`).
    /// @return strategist The single strategist all the tokens' vaults agree on for `classId`.
    function _commitShipTokens(
        bytes32 strategyId,
        uint256 classId,
        address[] calldata tokens,
        uint256[] calldata amounts
    ) internal returns (address strategist) {
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            require(token != address(0), Errors.ZeroAddress());
            // O(n^2) duplicate scan: token lists are tiny (<= MAX_STRATEGY_TOKENS), and a duplicate would let
            // one token be committed twice under one strategy.
            for (uint256 j; j < i; ++j) {
                require(tokens[j] != token, Errors.DuplicateToken(token));
            }
            require(amounts[i] > 0, Errors.ZeroAmount());
            // Exposure knob: when on, refuse a token that another live strategy already backs.
            if (oneStrategyPerToken) {
                require(!_tokenHasLiveStrategy[token], Errors.TokenAlreadyHasLiveStrategy(token));
            }

            _requireVaultBacks(token, classId, amounts[i]);

            // All the class's vaults MUST name the same strategist; a per-vault mismatch is a misconfiguration
            // that would split signing authority, so it is rejected rather than silently trusting the first.
            address tokenStrategist = IAssetVault(_vaultFor(token)).classStrategist(classId);
            require(tokenStrategist != address(0), Errors.ClassHasNoStrategist(classId));
            if (i == 0) strategist = tokenStrategist;
            else require(tokenStrategist == strategist, Errors.ClassStrategistMismatch(classId));

            _strategyAmounts[strategyId][token] = amounts[i];
            _strategyTokens[strategyId].push(token);
            _tokenHasLiveStrategy[token] = true;
        }
    }

    /// @dev Resolve the strategist of a LIVE strategy (used by reship/dock) from its stored class + tokens.
    ///      Requires every token's vault to agree, so a mid-life `setClassStrategist` on one vault cannot split
    ///      authority and let a reship or dock be signed by only part of the class.
    /// @param strategyId The stable id of the live strategy.
    /// @return strategist The single strategist all the strategy's tokens' vaults agree on.
    function _liveStrategist(bytes32 strategyId) internal view returns (address strategist) {
        uint256 classId = _strategyClassId[strategyId];
        address[] storage tokens = _strategyTokens[strategyId];
        for (uint256 i; i < tokens.length; ++i) {
            address tokenStrategist = IAssetVault(_vaultFor(tokens[i])).classStrategist(classId);
            require(tokenStrategist != address(0), Errors.ClassHasNoStrategist(classId));
            if (i == 0) strategist = tokenStrategist;
            else require(tokenStrategist == strategist, Errors.ClassStrategistMismatch(classId));
        }
    }

    /// @dev The strategist-signature spine, shared by ship/reship/dock. Enforces expiry, consumes the
    ///      strategist's sequential nonce, and verifies the EIP-712 signature via `SignatureChecker`; which
    ///      accepts an ERC-1271 smart-wallet signature (the real strategist) as well as an EOA. The nonce is
    ///      per strategist and strictly sequential, so a captured signature cannot be replayed and the domain
    ///      separator's chainId + verifyingContract stop cross-chain and cross-adapter replay.
    /// @param strategist The address whose signature must authorize the action.
    /// @param structHash The EIP-712 struct hash of the specific action (ship/reship/dock).
    /// @param nonce      The nonce carried by the signed message (must equal the strategist's current value).
    /// @param deadline   Signature expiry (unix seconds).
    /// @param sig        The strategist's signature (EOA or ERC-1271).
    function _verifyStrategist(
        address strategist,
        bytes32 structHash,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) internal {
        require(block.timestamp <= deadline, Errors.SignatureExpired(deadline, block.timestamp));

        // Strictly sequential per-strategist nonce: the message must carry the current value, which then
        // increments, so a captured signature cannot be replayed even within its deadline window.
        uint256 expected = strategistNonces[strategist];
        require(nonce == expected, Errors.StrategistNonceMismatch(strategist, nonce, expected));
        strategistNonces[strategist] = expected + 1;

        // `isValidSignatureNow` accepts an ERC-1271 smart-wallet signature as well as an EOA, so a smart-wallet
        // strategist is supported. The domain separator binds chainId + this adapter, blocking cross-chain and
        // cross-adapter replay of the same struct.
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        require(SignatureChecker.isValidSignatureNow(strategist, digest, sig), Errors.NotStrategist(strategist));
    }

    /// @dev EIP-712 domain separator, built with the frozen `DOMAIN_NAME_HASH` and the live chainId/address.
    ///      Reading `block.chainid` live keeps it correct across a chain fork without a stored cache.
    /// @return The domain separator for this adapter on the current chain.
    function _domainSeparator() internal view returns (bytes32) {
        return
            keccak256(abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, block.chainid, address(this)));
    }

    /// @dev Copy a live strategy's token list into memory (a storage ref does not survive `aqua.dock`) with
    ///      the shipped reserve and Aqua's live per-token inventory. Must be called BEFORE the dock, since the
    ///      dock zeroes Aqua's ledger; the returned triple is what the reconcile event carries for off-chain
    ///      PnL settlement.
    /// @param strategyId The stable id of the strategy being snapshotted.
    /// @param hash       The strategy's current Aqua hash (its Aqua ledger key).
    /// @return tokens        The strategy's token list, copied to memory.
    /// @return shipped       The reserve this adapter shipped per token.
    /// @return venueReturned Aqua's live per-token inventory at snapshot time.
    function _snapshotStrategy(bytes32 strategyId, bytes32 hash)
        internal
        view
        returns (address[] memory tokens, uint256[] memory shipped, uint256[] memory venueReturned)
    {
        // Copy to memory: the storage token list is deleted during teardown, so a storage ref read after the
        // dock would be empty. Snapshot here, dock after.
        address[] storage live = _strategyTokens[strategyId];
        uint256 n = live.length;
        tokens = new address[](n);
        shipped = new uint256[](n);
        venueReturned = new uint256[](n);

        for (uint256 i; i < n; ++i) {
            address token = live[i];
            tokens[i] = token;
            shipped[i] = _strategyAmounts[strategyId][token]; // what this adapter shipped
            (uint248 balance,) = aqua.rawBalances(address(this), aquaSwapVMRouter, hash, token);
            venueReturned[i] = uint256(balance); // what Aqua still holds (the reconcile counterpart)
        }
    }

    /// @dev Clear one token's strategy state. No allowance to revoke: there never was a standing one, since the
    ///      just-in-time approval in `preTransferOut` is consumed to zero by the pull that follows it.
    /// @param strategyId The strategy being torn down.
    /// @param token      The token whose per-strategy state and live-strategy flag are cleared.
    function _releaseToken(bytes32 strategyId, address token) internal {
        delete _strategyAmounts[strategyId][token];
        _tokenHasLiveStrategy[token] = false;
    }
}
