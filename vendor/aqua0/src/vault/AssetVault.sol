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
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { Roles } from "../lib/Roles.sol";
import { Events } from "../lib/Events.sol";
import { Errors } from "../lib/Errors.sol";
import { Strategy, RedeemRequest, FrontLock, Alloc, FrontObligation } from "../lib/Types.sol";
import { VaultMath } from "./lib/VaultMath.sol";
import { HybridPnLLib } from "./lib/HybridPnLLib.sol";
import { FrontLockLib } from "./lib/FrontLockLib.sol";
import { FrontObligationLib } from "./lib/FrontObligationLib.sol";
import { AsyncRedeemLib } from "./lib/AsyncRedeemLib.sol";
import { PoolLib } from "./lib/PoolLib.sol";

/// @title AssetVault (shared-pool capital model)
/// @author Aqua0 Team
/// @notice Single-asset vault, one of the Aqua0 asset vaults (one proxy per asset per chain). Capital is a single
///         non-subtractive shared pool: a deposit is one shared principal cap (`principal[lp]`), committed as
///         backing to many strategies without partitioning, and sourced from `sharedIdle` at swap time.
///         `deployedByLp[lp] <= principal[lp]` bounds each LP's loss; `amount <= sharedIdle` on every debit
///         bounds vault solvency. Each LP holds a NON-TRANSFERABLE per-strategy position, exposed as a
///         read-only `balanceOf(lp, strategyId)` view over the committed backing; principal is a separate
///         shared per-LP claim. Fees accrue by actual participation (`deployedInto`) into `credit`; there is no
///         separately-minted share ledger and no per-swap mint/burn.
/// @dev Beacon implementation (NOT UUPS): the shared `UpgradeableBeacon`, owned by the timelocked multisig, is
///      the sole upgrade authority, so there is no `_authorizeUpgrade` here. `ReentrancyGuard` is the
///      non-upgradeable OZ v5 variant (ERC-7201 namespaced, proxy-safe). Fresh design; no upgrade path from
///      the retired per-class model. Bulk logic is delegatecalled into `PoolLib` / `HybridPnLLib` /
///      `FrontLockLib` / `AsyncRedeemLib`; the fund-authority + solvency require sites stay legible and
///      auditor-visible here, per the refactor guardrails.
contract AssetVault is Initializable, AccessControlUpgradeable, PausableUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---- Identity ----

    /// @notice The single underlying ERC-20 asset (immutable for this vault, set at init).
    address public asset;

    /// @notice Human-readable vault name (metadata only; no accounting reads it).
    string public name;

    /// @notice Human-readable vault symbol (metadata only; no accounting reads it).
    string public symbol;

    // ---- Shared custody (replaces per-class idleAssets/deployedAssets) ----

    /// @notice The single undeployed balance backing all strategies. Every capital-removing path debits this
    ///         under `nonReentrant` after `require(amount <= sharedIdle)`.
    uint256 public sharedIdle;

    /// @notice Sum over strategies of principal currently sourced out (`Σ strategy.deployed`). Fast global read.
    uint256 public totalDeployed;

    // ---- Per-LP principal ledger (the shared per-LP cap) ----

    /// @notice Deposit-funded cap = the LP's ceiling. A single scalar; never represented by any share id.
    mapping(address => uint256) public principal;

    /// @notice Principal currently sourced out on the LP's behalf across all their strategies;
    ///         `deployedByLp[lp] <= principal[lp]` at all times.
    mapping(address => uint256) public deployedByLp;

    /// @notice Realized net PnL (fees), withdrawable, NOT part of the deploy cap.
    mapping(address => uint256) public credit;

    /// @notice The portion of `sharedIdle` claimed as segregated fees (LOCK-FEES): excluded from deployable
    ///         idle so a deploy / mid-swap sell can never source fee tokens owed to LPs. `>= Σ credit[lp]`
    ///         (a booked fee raises this at booking; a credit claim is crystallized from it and withdrawn).
    ///         Only the `orphanedSegregatedFees` part of it is ever releasable.
    uint256 public segregatedFees;

    // ---- Per-strategy record ----

    /// @notice Per-strategy records keyed by registry-issued `strategyId` (also the position id).
    mapping(uint256 => Strategy) internal _strategies;

    /// @notice LP consent: does `lp` back `strategyId` (a non-subtractive record, not a token move)?
    mapping(address => mapping(uint256 => bool)) public committed;

    /// @notice `lp`'s principal currently sourced into `strategyId` via a committed ship (deploy/return), out
    ///         at a venue and returning to this vault. `Σ_lp deployedInto[lp][s] == _strategies[s].deployed`.
    mapping(address => mapping(uint256 => uint256)) public deployedInto;

    /// @notice `lp`'s principal COMPOSED INTO `strategyId`, held in THIS vault as this vault's asset - a
    ///         single-sided LP's proceeds from a cross-vault swap, credited via
    ///         `settleVenueCredit`. Redeemable via `redeemComposition`. Distinct from `deployedInto` (at a
    ///         venue) and from free `principal`. `Σ_lp composition[s][lp] == strategyComposition[s]`.
    mapping(uint256 => mapping(address => uint256)) public composition;

    /// @notice Running aggregate of `composition` per strategy in this vault (the conservation compare).
    mapping(uint256 => uint256) public strategyComposition;

    // ---- Bounded committer / commitment sets (exact pro-rata needs O(committers) per fill) ----

    /// @notice The committer address list per strategy (bounded by `maxCommittersPerStrategy`), iterated by
    ///         the pro-rata-by-room source pass and the conservation fold.
    mapping(uint256 => address[]) internal _committers;

    /// @notice `_committers[s]` membership index + 1 (0 = absent), for O(1) removal.
    mapping(uint256 => mapping(address => uint256)) internal _committerIndexPlus1;

    /// @notice The strategy-id list an LP has committed to (bounded by `maxCommitmentsPerLp`), iterated by
    ///         withdraw / uncommit to keep each committed strategy's backing above its sourced principal.
    mapping(address => uint256[]) internal _committed;

    /// @notice `_committed[lp]` membership index + 1 (0 = absent), for O(1) removal.
    mapping(address => mapping(uint256 => uint256)) internal _commitmentIndexPlus1;

    /// @notice Bound on a strategy's committer set. Small + tunable; the storage above is laid out so this can
    ///         be raised later WITHOUT a layout break (the exact pro-rata / O(1)-attribution unbounded variant
    ///         is the post-beta fast-follow).
    uint256 public maxCommittersPerStrategy;

    /// @notice Bound on how many strategies one LP may commit to (withdraw/uncommit iterate this set).
    uint256 public maxCommitmentsPerLp;

    // ---- Per-strategy fee accumulator (v3-style, O(1) per fill / per claim) ----

    /// @notice `feeCheckpointRay[lp][strategyId]` = the LP's last-seen `feePerShareRay` for the strategy;
    ///         accrued fee since is credited to `credit[lp]` on any participation change or claim.
    mapping(address => mapping(uint256 => uint256)) public feeCheckpointRay;

    // ---- Hybrid-PnL route accounting + config ----

    mapping(uint256 => mapping(bytes32 => uint256)) internal _routeReportedGain;
    mapping(uint256 => mapping(bytes32 => uint256)) internal _routeReportedLoss;
    mapping(bytes32 => bool) internal _settlementConsumed;

    /// @notice Hard ceiling on `maxBpsPerEpoch`: admin cannot set a gain-streaming rate above this.
    uint16 public constant MAX_BPS_PER_EPOCH_CEILING = 500;

    /// @notice Hard ceiling on how many epochs one `report` may advance (anti-jump bound).
    uint64 public constant MAX_EPOCH_ADVANCE = 10_000;

    /// @notice Lower bound on a settable `epochLength`.
    uint64 public constant MIN_EPOCH_LENGTH = 1 hours;

    /// @notice Upper bound on a settable `epochLength`.
    uint64 public constant MAX_EPOCH_LENGTH = 30 days;

    /// @notice The gain-streaming epoch length in seconds (bounded by MIN/MAX_EPOCH_LENGTH).
    uint64 public epochLength;

    /// @notice The per-epoch gain clamp in bps of the PnL base (bounded by MAX_BPS_PER_EPOCH_CEILING).
    uint16 public maxBpsPerEpoch;

    /// @notice The bridge-reconciliation tolerance in bps (`onBridgeSettle`).
    uint16 public reconcileToleranceBps;

    // ---- ERC-7540 async redeem (deployed-principal exits), re-scoped to the shared pool ----

    /// @notice Immutable never-trapped ceiling: no per-route settlement timeout may exceed this.
    uint64 public constant GLOBAL_MAX_TIMEOUT = 7 days;

    /// @notice Async-redeem requests keyed by monotonic request id.
    mapping(uint256 => RedeemRequest) public redeemRequests;

    /// @notice The last-issued request id; pre-incremented on each `requestRedeem`.
    uint256 public nextRequestId;

    /// @notice Strategy id to its bound settlement-route key (selects the claim timeout).
    mapping(uint256 => bytes32) public settlementRoute;

    /// @notice Route to its configured async-redeem claim timeout (0 falls back to `GLOBAL_MAX_TIMEOUT`).
    mapping(bytes32 => uint64) public routeTimeout;

    /// @notice Principal an LP has escrowed against pending async redeems (deployed-principal exits). Reserves
    ///         the claim so the freed capital is not withdrawn / re-sourced out from under the redeemer; it bites
    ///         only once the deployed capital returns (`freePrincipal` uses `max(deployedByLp, asyncHeld)`).
    mapping(address => uint256) public asyncHeld;

    // ---- Live-TVL meter (monitoring only; deposits are permissionless) ----

    /// @notice Sum of live principal in the vault, pushed to the liquidity indexer's rollup. Bookkeeping only:
    ///         it gates nothing (deposits are permissionless; any access gating is UI-only).
    uint256 public vaultLiveTvl;

    // ---- Mid-swap net settlement (per-vault outflow meter) ----

    /// @notice The tumbling-window length for the mid-swap outflow meter.
    uint256 public constant VENUE_OUTFLOW_WINDOW = 1 days;

    /// @notice The tumbling-window length for the fronting-release meter.
    uint256 public constant FRONTING_RELEASE_WINDOW = 1 days;

    /// @notice The per-window mid-swap net-outflow budget (0 is a hard stop, not "unlimited").
    uint256 public venueOutflowLimit;

    /// @notice The start timestamp of the live mid-swap outflow window.
    uint256 public venueOutflowWindowStart;

    /// @dev The net outflow accrued in the live mid-swap window (reset when the window rolls).
    uint256 internal _venueOutflowNet;

    // ---- Vesting clock (pause-aware) ----

    /// @notice Vault-clock timestamp of the current pause (0 when unpaused); freezes the vault clock.
    uint64 public vaultPausedAt;

    /// @notice Total seconds the vault has spent paused, subtracted from wall-clock by `_vaultNow`.
    uint64 public vaultFrozenSeconds;

    // ---- Cross-chain LP fronting ----

    /// @notice Domain separator constant for the front-landing settlement key.
    bytes32 public constant FRONT_LANDING_DOMAIN = keccak256("AQUA0_FRONT_LANDING");

    /// @notice FrontLock records keyed by front id (the None/Locked/Committed/Released/Cancelled machine).
    mapping(bytes32 => FrontLock) public frontLocks;

    /// @notice The LP self-cancel window for a Locked front (bounded by `GLOBAL_MAX_TIMEOUT`).
    uint64 public frontLockTimeout;

    /// @notice The per-window fronting-release budget (0 disables new releases).
    uint256 public frontingReleaseLimit;

    /// @notice The start timestamp of the live fronting-release window.
    uint256 public frontingReleaseWindowStart;

    /// @dev The net release accrued in the live fronting-release window (reset when the window rolls).
    uint256 internal _frontingReleaseNet;

    /// @notice Sum of the hard asset reservations of all Committed-but-not-Released fronts: a cross-chain front
    ///         hard-locks ASSETS at commit, subtracted from shared availability so the same idle is never
    ///         double-promised across fronts and same-chain swaps.
    uint256 public frontReservedAssets;

    /// @notice Principal an LP has locked into a Locked/Committed front (the non-transferable principal-claim
    ///         escrow substrate). Held out of the LP's free principal until the front releases or cancels.
    mapping(address => uint256) public frontHeldPrincipal;

    /// @dev Reserves future variable slots. Not frozen pre-deploy (the layout is re-blessable).
    /// @notice Destination-side fronting obligations, keyed by the cross-chain `frontId`. One front fans out
    ///         across N fillers, so each id maps to an array.
    mapping(bytes32 => FrontObligation[]) internal _frontObligations;

    /// @notice The open front a filler is committed to on a strategy, or zero. Enforces one-open-front-per
    ///         `(filler, strategyId)`: a second would overwrite the first, orphaning an obligation and routing
    ///         one beneficiary's value to another.
    mapping(address => mapping(uint256 => bytes32)) public openFrontOf;

    /// @notice Count of unsettled front obligations naming `lp` as beneficiary on `strategyId`. A beneficiary is
    ///         committed at open while both `deployedInto` and `composition` are still zero, so the two
    ///         un-commit gates that read realised state are blind for the whole bridge window. This is the third
    ///         gate: it makes the pending claim visible to `setCommitment(strategyId, false)`.
    mapping(address => mapping(uint256 => uint256)) public pendingFrontCredits;

    /// @notice The part of `segregatedFees` that is owed to nobody: a mid-swap spread reserved for an
    ///         allocation that named no draw, so no LP was credited for it. Every other part of
    ///         `segregatedFees` backs either crystallized `credit` or an LP's pending accrual, and no path
    ///         restores it once released, so `reconcileSegregatedFees` is bounded by THIS and never by
    ///         `segregatedFees`.
    uint256 public orphanedSegregatedFees;

    /// @dev The fronting mappings above consume reserved slots (19 - 4). Grown by one more when the former
    ///      `liquidityIndexer` slot was removed, keeping the reserved footprint constant. A layout shift is
    ///      acceptable here only because the vaults redeploy fresh; the baseline is re-blessed to match.
    uint256[16] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize a beacon-proxy vault instance.
    /// @dev `initializer`-gated (one-shot); the constructor disabled initializers on the implementation so only
    ///      proxies initialize. Reverts `ZeroAddress` if asset/admin/pauser is zero and `OutflowLimitUnset` if
    ///      the meter budget is zero. Grants `PAUSER_ROLE` to both the configured pauser AND `msg.sender` (the
    ///      factory) so the vault-wide `pauseAll` works immediately after creation.
    /// @param asset_ The single underlying ERC-20 this vault custodies (immutable for the vault's life).
    /// @param name_ Human-readable vault name (metadata only).
    /// @param symbol_ Human-readable vault symbol (metadata only).
    /// @param admin The `DEFAULT_ADMIN_ROLE` holder (the timelocked multisig in production).
    /// @param pauser The initial `PAUSER_ROLE` holder (the pause-only relayer).
    /// @param venueOutflowLimit_ The mid-swap net-outflow budget per window. Required NON-ZERO: the meter is
    ///        the sole solvency-rate boundary under JIT, so a vault must never begin life unmetered.
    function initialize(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        address admin,
        address pauser,
        uint256 venueOutflowLimit_
    ) external initializer {
        require(address(asset_) != address(0) && admin != address(0) && pauser != address(0), Errors.ZeroAddress());
        require(venueOutflowLimit_ != 0, Errors.OutflowLimitUnset());
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.PAUSER_ROLE, pauser);
        _grantRole(Roles.PAUSER_ROLE, msg.sender);

        // Capital-moving roles (COMPOSER_ROLE, VENUE_SETTLER_ROLE) are administered by a role SEPARATE from
        // DEFAULT_ADMIN_ROLE, even though both start out held by the same `admin` address: an admin holding
        // ONLY DEFAULT_ADMIN_ROLE (e.g. after a future handoff that rotates one but not the other) can no
        // longer unilaterally self-grant a capital-moving role.
        _grantRole(Roles.CAPITAL_ADMIN_ROLE, admin);
        _setRoleAdmin(Roles.COMPOSER_ROLE, Roles.CAPITAL_ADMIN_ROLE);
        _setRoleAdmin(Roles.VENUE_SETTLER_ROLE, Roles.CAPITAL_ADMIN_ROLE);
        // Self-administered too (not left on the OZ default of DEFAULT_ADMIN_ROLE): CAPITAL_ADMIN_ROLE's own
        // handoff must not depend on the target still holding DEFAULT_ADMIN_ROLE, which a DEFAULT_ADMIN
        // renounce (part of the same admin-rotation flow) may already have revoked.
        _setRoleAdmin(Roles.CAPITAL_ADMIN_ROLE, Roles.CAPITAL_ADMIN_ROLE);

        asset = address(asset_);
        name = name_;
        symbol = symbol_;
        venueOutflowLimit = venueOutflowLimit_;

        epochLength = 1 days;
        maxBpsPerEpoch = 25;
        reconcileToleranceBps = 100;

        // Bounded-set seeds (tunable; storage laid out so a raise is layout-safe).
        maxCommittersPerStrategy = 16;
        maxCommitmentsPerLp = 64;
    }

    // ============================================================
    // Strategy registration lifecycle
    // ============================================================

    /// @notice Register a new strategy. Permissionless; the caller names its EIP-712 strategist.
    /// @dev Permissionless by design: strategy creation is open (parity with the Aqua maker's already
    ///      strategist-signed `shipStrategy`), and curation is moved from an admin to explicit LP consent. A
    ///      registration is INERT until an LP opts to back it AND capital is authorized: `deployCapital` /
    ///      `settleVenueOut` source ONLY the strategy's committers' free principal (bound `deployed + amount <=
    ///      Σ committer principal`, zero with no committers), every venue outflow is additionally bounded by
    ///      shared idle (INV-GLOBAL) and the rolling outflow meter, and the venue paths themselves require a
    ///      backend-signed op (Composer spine) or a `backendSigner`-signed V4 payload the caller does not hold.
    ///      So a bare `registerStrategy` by an arbitrary account moves no funds and cannot touch capital of LPs
    ///      who did not commit to it. Naming a strategist the caller does not control is equally inert: that
    ///      strategist must itself sign (`approveClassForPool` / `shipStrategy`) for the record to do anything.
    ///      The record is create-once - `ClassAlreadyRegistered` means this can only ever ADD a new strategy,
    ///      never mutate an existing one, so it cannot hijack a live strategy; `setStrategist` (current-strategist
    ///      only) is the sole mutator. `strategyId` is an opaque id (also the position id read by `balanceOf(lp,
    ///      strategyId)`); it is not validated against the registry on-chain, so squatting a specific id yields
    ///      only an inert record and a victim simply registers under another of the 2^256 ids. No bounded
    ///      resource is exhausted (strategies are mapping-keyed with no enumeration; committer/commitment sets
    ///      are bounded per-strategy/per-LP and grow only on LP action), so spam costs the spammer gas and
    ///      griefs nothing. `ZeroAddress` on a zero strategist keeps every strategy with a signer.
    /// @param strategyId The id to create the record under (opaque; doubles as the position id).
    /// @param strategist The EIP-712 signer authorized to ship/approve this strategy's venue curve (caller-chosen).
    function registerStrategy(uint256 strategyId, address strategist) external {
        require(!_strategies[strategyId].exists, Errors.ClassAlreadyRegistered(strategyId));
        require(strategist != address(0), Errors.ZeroAddress());
        _strategies[strategyId].exists = true;
        _strategies[strategyId].strategist = strategist;
        emit Events.ClassRegistered(address(this), strategyId);
        emit Events.ClassStrategistSet(address(this), strategyId, strategist);
    }

    /// @notice Rotate the strategist for a registered strategy. Self-service: only the CURRENT strategist.
    /// @dev Gated to the current strategist (not an admin) so strategist ownership transfer is self-service and
    ///      no admin key can seize a strategy's signer. Losing the strategist key does not trap any LP funds: it
    ///      only makes the strategy dormant (no new ships/approvals), while committed principal stays withdrawable
    ///      (`withdraw` / un-commit once no capital is live) and deployed principal returns via the Composer and
    ///      async redeem independent of the strategist. Reverts `ClassNotRegistered` for an unknown strategy,
    ///      `NotStrategist` for any caller other than the current strategist, and `ZeroAddress` for a zero target.
    /// @param strategyId The strategy to rotate (caller must be its current strategist).
    /// @param strategist The new EIP-712 signer.
    function setStrategist(uint256 strategyId, address strategist) external {
        _requireStrategy(strategyId);
        require(msg.sender == _strategies[strategyId].strategist, Errors.NotStrategist(msg.sender));
        require(strategist != address(0), Errors.ZeroAddress());
        _strategies[strategyId].strategist = strategist;
        emit Events.ClassStrategistSet(address(this), strategyId, strategist);
    }

    /// @notice The strategist bound to `strategyId` (zero if the strategy does not exist).
    /// @param strategyId The strategy to query.
    /// @return The strategist address, or the zero address if unregistered.
    function classStrategist(uint256 strategyId) external view returns (address) {
        return _strategies[strategyId].strategist;
    }

    /// @notice Whether `strategyId` has been registered on this vault.
    /// @param strategyId The strategy to query.
    /// @return True if the strategy record exists.
    function classExists(uint256 strategyId) public view returns (bool) {
        return _strategies[strategyId].exists;
    }

    // ============================================================
    // Pause (vault-wide + per-strategy)
    // ============================================================

    /// @notice Pause the whole vault. Also stops the vault clock.
    function pause() external onlyRole(Roles.PAUSER_ROLE) {
        vaultPausedAt = uint64(block.timestamp);
        _pause();
    }

    /// @notice Unpause the whole vault. Admin-only; banks the frozen interval so no gain vests during a freeze.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (vaultPausedAt != 0 && block.timestamp > vaultPausedAt) {
            vaultFrozenSeconds += uint64(block.timestamp) - vaultPausedAt;
        }
        vaultPausedAt = 0;
        _unpause();
    }

    /// @notice Pause a single strategy, freezing only its ops. Pause-only relayer authority.
    /// @param strategyId The strategy to pause.
    function pauseStrategy(uint256 strategyId) external onlyRole(Roles.PAUSER_ROLE) {
        _requireStrategy(strategyId);
        _pauseStrategy(strategyId);
    }

    /// @notice Unpause a single strategy. Admin-only. Re-bases its vesting/clamp windows forward by the frozen
    ///         interval so gain that did NOT stream while paused resumes rather than landing at once.
    /// @dev Also clears `reporterFrozen`, so an admin unpause lifts a guardian's report veto for the strategy.
    /// @param strategyId The strategy to unpause.
    function unpauseStrategy(uint256 strategyId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _requireStrategy(strategyId);
        Strategy storage s = _strategies[strategyId];
        if (s.paused) {
            uint256 nowV = _vaultNow();
            if (s.pausedAt != 0 && nowV >= s.pausedAt) {
                uint64 frozen = uint64(nowV) - s.pausedAt;
                if (s.vestStart != 0) s.vestStart += frozen;
                if (s.clampWindowStart != 0) s.clampWindowStart += frozen;
            }
            s.paused = false;
            s.pausedAt = 0;
        }
        s.reporterFrozen = false;
        emit Events.ClassUnpaused(address(this), strategyId);
    }

    /// @notice Whether `strategyId` is individually paused.
    /// @param strategyId The strategy to query.
    /// @return True if the strategy is individually paused.
    function classPaused(uint256 strategyId) public view returns (bool) {
        return _strategies[strategyId].paused;
    }

    /// @notice Whether `strategyId`'s PnL reporter is frozen by a guardian veto.
    /// @param strategyId The strategy to query.
    /// @return True if the strategy's reporter is frozen (a guardian veto is active).
    function classReporterFrozen(uint256 strategyId) public view returns (bool) {
        return _strategies[strategyId].reporterFrozen;
    }

    // ============================================================
    // Views
    // ============================================================

    /// @notice The LP's NON-TRANSFERABLE position in `strategyId`: their committed backing (their
    ///         principal while committed, else 0). A read-only view over the internal ledger; a stable stake
    ///         that does not read 0 when the LP's capital is momentarily idle. There is no transfer / approve.
    /// @dev This is an ERC-6909-SHAPED getter, not the ERC-6909 interface. There is no token ledger behind it:
    ///      no `transfer` / `transferFrom` / `approve` / `allowance` / operator surface, no `Transfer` event,
    ///      and `supportsInterface` reports the standard's id as unsupported. Integrators must read it as a
    ///      view and must not subscribe to transfer events that can never fire.
    /// @param owner The LP whose position is read.
    /// @param strategyId The strategy the position is against.
    /// @return The LP's committed principal for the strategy (0 when not committed).
    function balanceOf(address owner, uint256 strategyId) public view returns (uint256) {
        return committed[owner][strategyId] ? principal[owner] : 0;
    }

    /// @notice Principal `strategyId` currently has sourced out (Σ over its committers).
    /// @param strategyId The strategy to query.
    /// @return The strategy's currently-deployed principal.
    function deployedAssets(uint256 strategyId) public view returns (uint256) {
        _requireStrategy(strategyId);
        return _strategies[strategyId].deployed;
    }

    /// @notice This strategy's non-subtractive backing ceiling, derived as Σ current principal over its
    ///         committers (deposits after commit count automatically; there is no snapshot to go stale).
    /// @param strategyId The strategy to query.
    /// @return The derived backing ceiling (sum of committers' current principal).
    function committedBacking(uint256 strategyId) public view returns (uint256) {
        _requireStrategy(strategyId);
        return PoolLib.committedBacking(principal, _committers[strategyId]);
    }

    /// @notice The deployable room for `strategyId` right now: `min(sharedIdle, committedBacking - deployed)`.
    /// @dev The upper bound a `VENUE_SETTLER` may net-send / a `deployCapital` may source for this strategy.
    ///      The `AquaAdapter` ship-time precheck reads THIS (re-pointed from the retired per-class idle view).
    ///      Uses `_availableIdle()` (idle less the front reservation and segregated fees), NOT raw `sharedIdle`,
    ///      so neither reserved bucket is ever offered as deployable room. Returns 0 for an unknown strategy.
    /// @param strategyId The strategy to query.
    /// @return The deployable room (min of available idle and the strategy's unused backing).
    function availableFor(uint256 strategyId) public view returns (uint256) {
        Strategy storage s = _strategies[strategyId];
        if (!s.exists) return 0;
        uint256 backing = PoolLib.committedBacking(principal, _committers[strategyId]);
        uint256 backingRoom = backing > s.deployed ? backing - s.deployed : 0;
        uint256 idle = _availableIdle();
        return idle < backingRoom ? idle : backingRoom;
    }

    /// @notice An LP's free (unencumbered) principal. The async escrow (`asyncHeld`) and the deployed principal
    ///         (`deployedByLp`) overlap - a pending redeem targets deployed principal - so they combine as a
    ///         `max`, not a sum: while the capital is deployed the escrow does not further restrict, and once it
    ///         returns (deployedByLp drops below asyncHeld) the escrow reserves the redeemer's claim.
    /// @param lp The LP whose free principal is computed.
    /// @return The LP's unencumbered principal (total less the max of deployed/async-held, less front holds).
    function freePrincipal(address lp) public view returns (uint256) {
        uint256 deployedOrHeld = deployedByLp[lp] > asyncHeld[lp] ? deployedByLp[lp] : asyncHeld[lp];
        uint256 encumbered = deployedOrHeld + frontHeldPrincipal[lp];
        return principal[lp] > encumbered ? principal[lp] - encumbered : 0;
    }

    /// @notice An LP's total withdrawable now: free principal + realized credit, bounded by shared idle.
    /// @param owner The LP to query.
    /// @return The withdrawable amount (min of free principal + credit and the deployable idle).
    function maxWithdraw(address owner) public view returns (uint256) {
        uint256 payable_ = freePrincipal(owner) + credit[owner];
        uint256 idle = _availableIdle();
        return payable_ < idle ? payable_ : idle;
    }

    /// @notice The strategy's PnL-claim assets-per-share in RAY; a drift metric, not an accounting value.
    /// @param strategyId The strategy to query.
    /// @return The RAY-scaled share price (drift metric only; no capital math reads it).
    function sharePriceRay(uint256 strategyId) external view returns (uint256) {
        _requireStrategy(strategyId);
        return VaultMath.sharePriceRay(_strategies[strategyId], _vaultNow());
    }

    /// @notice The committer set of `strategyId` (bounded).
    /// @param strategyId The strategy to query.
    /// @return The strategy's committer addresses.
    function committersOf(uint256 strategyId) external view returns (address[] memory) {
        return _committers[strategyId];
    }

    /// @notice Per-committer cross-vault composition: `committer`'s principal for `strategyId` held in `asset_`.
    ///         This vault custodies one asset, so it returns the committer's `composition` for that asset (their
    ///         cross-vault swap proceeds) and 0 for any other. A pair strategy's full per-committer, per-asset
    ///         composition is the union of the two per-asset vaults' `composition` ledgers.
    /// @param strategyId The strategy to query.
    /// @param committer The committer whose composition is read.
    /// @param asset_ The asset the composition is denominated in; only this vault's own asset is held here.
    /// @return The committer's composition for the strategy in `asset_` (0 for any asset but this vault's).
    function compositionBal(uint256 strategyId, address committer, address asset_) external view returns (uint256) {
        return asset_ == asset ? composition[strategyId][committer] : 0;
    }

    /// @notice Running aggregate: `strategyId`'s composition holdings in `asset_` (the conservation compare).
    ///         Equals `Σ committer composition` for this vault's asset.
    /// @param strategyId The strategy to query.
    /// @param asset_ The asset to query; only this vault's own asset is held here.
    /// @return The strategy's aggregate composition in `asset_` (0 for any asset but this vault's).
    function strategyHoldings(uint256 strategyId, address asset_) external view returns (uint256) {
        return asset_ == asset ? strategyComposition[strategyId] : 0;
    }

    // ============================================================
    // Deposit + commitment (the shared-pool entry surface)
    // ============================================================

    /// @notice Deposit `assets` of the underlying into the shared pool, funding `receiver`'s principal cap.
    /// @dev No shares are minted at deposit (per-strategy shares are PnL claims minted on source). FOT-safe:
    ///      books the amount the vault ACTUALLY received.
    /// @param assets Requested deposit amount pulled from `msg.sender`.
    /// @param receiver Account whose principal cap is funded.
    /// @return received Amount actually credited to principal (the measured post-transfer delta, FOT-safe).
    function deposit(uint256 assets, address receiver) external whenNotPaused nonReentrant returns (uint256 received) {
        require(assets > 0, Errors.ZeroAmount());
        require(receiver != address(0), Errors.ZeroAddress());

        received = _pullMeasured(msg.sender, assets);

        principal[receiver] += received;
        sharedIdle += received;
        vaultLiveTvl += received;

        emit Events.VaultDeposit(address(this), msg.sender, receiver, received);
    }

    /// @notice Set (or clear) a non-subtractive commitment of the caller's principal as backing for
    ///         `strategyId`. Committing to A does not reduce what is available to commit to B.
    /// @param strategyId The strategy to commit to or uncommit from.
    /// @param backing True to commit (requires non-zero principal), false to clear (always allowed).
    function setCommitment(uint256 strategyId, bool backing) external whenNotPaused nonReentrant {
        _setCommitment(msg.sender, strategyId, backing);
    }

    /// @notice Batch commitment set/clear.
    /// @dev Reverts `LengthMismatch` if the two arrays differ in length; otherwise applies each pair in order.
    /// @param strategyIds The strategy ids to set commitments on.
    /// @param backing Per-id commit (true) / clear (false) flags, index-aligned with `strategyIds`.
    function setCommitments(uint256[] calldata strategyIds, bool[] calldata backing)
        external
        whenNotPaused
        nonReentrant
    {
        require(strategyIds.length == backing.length, Errors.LengthMismatch());
        for (uint256 i; i < strategyIds.length; ++i) {
            _setCommitment(msg.sender, strategyIds[i], backing[i]);
        }
    }

    // ============================================================
    // Withdraw + strategy PnL claim
    // ============================================================

    /// @notice Withdraw `assets` from the shared pool to `receiver`, drawn from `owner`'s free principal first,
    ///         then realized credit. Only the owner may move their principal (non-transferable ledger, v1).
    /// @dev Reverts `ZeroAmount`/`ZeroAddress` on bad inputs; `PoolLib.withdraw` enforces owner authorization
    ///      and bounds the draw by `_redeemableIdle()` (all idle less the front reservation, since the credit
    ///      leg is paid from `segregatedFees`). The credit portion drawn is subtracted from `segregatedFees` to
    ///      keep the `segregatedFees >= Σ credit` invariant.
    /// @param assets The amount to withdraw.
    /// @param receiver The account paid the assets.
    /// @param owner The principal owner whose free principal + credit funds the withdrawal (must be the caller).
    /// @return The amount withdrawn (equal to `assets`).
    function withdraw(uint256 assets, address receiver, address owner)
        external
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        require(assets > 0, Errors.ZeroAmount());
        require(receiver != address(0), Errors.ZeroAddress());
        uint256 fromCredit;
        (sharedIdle, vaultLiveTvl, fromCredit) = PoolLib.withdraw(
            principal,
            deployedByLp,
            frontHeldPrincipal,
            asyncHeld,
            credit,
            receiver,
            owner,
            asset,
            // Withdraw draws FREE principal (net of the fronting hold + async escrow) AND credit; credit comes
            // from the segregated fees, so the bound is the redeemable idle (all of sharedIdle less the fronting
            // reservation), not the deployable idle.
            PoolLib.WithdrawState(assets, _redeemableIdle(), sharedIdle, vaultLiveTvl)
        );
        // The credit portion is drawn from the segregated fee bucket (it was excluded from deployable idle).
        segregatedFees -= fromCredit;
        return assets;
    }

    /// @notice Crystallize the caller's accrued segregated fee (LOCK-FEES) for `strategyId` into withdrawable
    ///         `credit`, which is then withdrawn via `withdraw`.
    /// @dev The fee accrues by actual participation (`deployedInto`) via the v3-style accumulator; O(1). Loss
    ///      (IL) attribution against `pnlPool` is a later-scoped cross-vault feature. Reverts `ClassNotRegistered`
    ///      for an unknown strategy. Only crystallizes into `credit`; the caller then withdraws it via `withdraw`.
    /// @param strategyId The strategy whose accrued participation fee is crystallized.
    /// @return accrued Amount moved into withdrawable `credit` by this call (0 if nothing was pending).
    function redeemStrategyPnL(uint256 strategyId) external whenNotPaused nonReentrant returns (uint256 accrued) {
        _requireStrategy(strategyId);
        uint256 creditBefore = credit[msg.sender];
        PoolLib.accrueOne(
            credit, feeCheckpointRay, deployedInto, msg.sender, strategyId, _strategies[strategyId].feePerShareRay
        );
        accrued = credit[msg.sender] - creditBefore;
        emit Events.StrategyPnLClaimed(address(this), strategyId, msg.sender, msg.sender, 0, accrued);
    }

    // ============================================================
    // Composer custody seam (shared idle <-> venues; per-LP attribution)
    // ============================================================

    /// @notice Source `amount` of shared idle into `strategyId` and send it to `venue` (committed ship).
    /// @dev Composer-gated. The pro-rata-by-room source (`PoolLib._source`), its three fund-safety require
    ///      sites, and the per-committer fee accrual all run inside `PoolLib.deployIntoVenue` (no shares are
    ///      minted). Reverts on an unknown or paused strategy, a zero venue, or a zero amount. Sources against
    ///      `_availableIdle()` (idle less the front reservation + segregated fees), so a deploy can never pull
    ///      capital promised to a front or owed to LPs as fees.
    /// @param strategyId The strategy to source principal for.
    /// @param venue The recipient of the shipped principal (the venue adapter / router).
    /// @param amount The principal to source and ship (subject to the idle and per-committer bounds).
    function deployCapital(uint256 strategyId, address venue, uint256 amount)
        external
        onlyRole(Roles.COMPOSER_ROLE)
        whenNotPaused
        nonReentrant
    {
        _requireActiveStrategy(strategyId);
        require(venue != address(0), Errors.ZeroAddress());
        // The venue must be external: a self-directed egress lands back in the vault, so the receipt meter reads
        // the full amount as a shortfall and books it as a realized loss against the sourcing committers though no
        // capital ever left custody. The registry adapter allowlist is not wired to this vault, so this is the
        // guard that keeps the destination off the vault itself.
        require(venue != address(this), Errors.VenueIsSelf());
        require(amount > 0, Errors.ZeroAmount());

        // SOURCE + measure-and-book EGRESS, in one PoolLib call. Sourcing books `amount` as the strategy's (and
        // its committers') deployed principal and draws it from idle; the egress transfers `amount`, measures what
        // the VENUE received, and books that. A short landing means the ASSET took a fee or rebased down (a plain
        // ERC-20 transfer hands the recipient NO execution, so it cannot be the venue forwarding onward). Rather
        // than fail closed - which would brick deploys of every fee-on-transfer / rebasing asset - it charges the
        // shortfall as a realized loss to exactly the committers who sourced this deploy, pro-rata, so `deployed`
        // ends equal to the delivered (recoverable) amount and no phantom principal is left booked. The returned
        // `booked` is `min(amount, delivered)`: `deployed` is never inflated above what was sourced (a positive-
        // rebase surplus stays at the venue and returns later as a gain via `returnCapital`).
        uint256 booked;
        (booked, sharedIdle, totalDeployed, vaultLiveTvl) = PoolLib.deployIntoVenue(
            _strategies,
            principal,
            deployedByLp,
            deployedInto,
            credit,
            feeCheckpointRay,
            frontHeldPrincipal,
            asyncHeld,
            _committers[strategyId],
            PoolLib.DeployState(
                strategyId, amount, _availableIdle(), sharedIdle, totalDeployed, vaultLiveTvl, asset, venue
            )
        );

        emit Events.ClassCapitalDeployed(address(this), strategyId, venue, booked);
        _assertStrategyConservation(strategyId);
    }

    /// @notice Return `amount` of `strategyId`'s principal from `venue` back into shared idle (FOT-safe).
    /// @dev Composer-gated. Books the ACTUAL received amount back to shared idle, reducing the strategy's
    ///      sourced principal (and its committers' composition) pro-rata; a surplus over the strategy's
    ///      sourced principal is a realized GAIN routed to the fee accumulator (pause-gated up-mark).
    ///
    ///      `finalClose` is the backend's signal that this return FULLY closes the strategy's deployed position
    ///      (the venue has handed back everything it holds). It is load-bearing because the vault sees only
    ///      `received` and cannot tell a legitimate PARTIAL return (the rest still recoverable at the venue) from
    ///      a FINAL close that came up short (a fee-on-transfer return skim, or a realized trading loss). On a
    ///      final close where `received < deployed`, the unrecoverable residual is charged as a realized loss to
    ///      the returning committers pro-rata (`principal` written down, `deployedInto -> 0`), so no phantom
    ///      `deployed` residue is stranded and the committer is not trapped. On a partial return (`finalClose ==
    ///      false`) the residual is left as legitimately-still-deployed, exactly as before.
    ///
    ///      SHARP EDGE, caller beware: a final close returns EVERYTHING outstanding, or it is NOT a close, it is a
    ///      LOSS. Setting `finalClose` while capital is still legitimately at the venue (a would-be partial) unwinds
    ///      the WHOLE position and books `deployed - received` as a realized loss to the committers (demonstrated
    ///      live on the staging fork: returning 1 with 3 outstanding wrote principal down 4 -> 2). So set
    ///      `finalClose` ONLY when the venue has returned all it holds. This bit is guardian-vetoable / pause-gated
    ///      because it reduces principal on a possibly-wrong signal (see below). The Composer carries `finalClose`
    ///      as a BOOLEAN sentinel on the RETURN op (`op.pnl != 0`), NEVER a PnL value: a caller that passes a raw
    ///      PnL number into a RETURN's `pnl` field detonates this loss by accident. Sign `pnl` = 0
    ///      (partial/ordinary return) or 1 (final close) ONLY; a RETURN's `pnl` is not a delta.
    /// @param strategyId The strategy whose deployed principal is returning.
    /// @param venue The venue the principal returned from (event context; the tokens are pulled from the caller).
    /// @param amount The amount pulled from the caller; the MEASURED receipt is what is booked (FOT-safe).
    /// @param finalClose True only when the venue has returned EVERYTHING it holds; a short final close writes
    ///        the residual down as a realized loss. False leaves any residual as still-deployed.
    function returnCapital(uint256 strategyId, address venue, uint256 amount, bool finalClose)
        external
        onlyRole(Roles.COMPOSER_ROLE)
        nonReentrant
    {
        _requireStrategy(strategyId);
        require(venue != address(0), Errors.ZeroAddress());
        require(amount > 0, Errors.ZeroAmount());

        uint256 received = _pullMeasured(msg.sender, amount);
        // A measured surplus over `deployed` is a realized GAIN (a pause-gated up-mark): gate it here, then let
        // `returnFromStrategy` book it (bumping `feePerShareRay`, or routing to `pnlPool` when nothing is
        // deployed) BEFORE it crystallizes the return, returning the amount to lock into `segregatedFees`.
        uint256 deployed = _strategies[strategyId].deployed;
        uint256 surplus = received > deployed ? received - deployed : 0;
        if (surplus > 0) {
            _requireNotPaused();
            _requireStrategyNotPaused(strategyId);
        }
        // A FINAL-close return that came up short (`received < deployed`) will WRITE DOWN LP PRINCIPAL, and the
        // full-close signal is backend-supplied and could be wrong (a partial mis-flagged as final would realize
        // a loss on still-recoverable capital). So, unlike an `onAdapterSettle` down-mark (always allowed), the
        // guardian MUST be able to stop an anomalous writedown: it is gated behind vault pause, strategy pause,
        // AND the guardian's `reporterFrozen` veto. The RECOVERED principal still returns via a partial
        // (`finalClose == false`) return while paused; only the loss FINALIZATION waits for the guardian to clear.
        if (finalClose && received < deployed) {
            _requireNotPaused();
            _requireStrategyNotPaused(strategyId);
            require(!_strategies[strategyId].reporterFrozen, Errors.ReporterFrozen(strategyId));
        }
        // Distribute the returned principal pro-rata; on a FINAL close that came up short, charge the leftover
        // `deployed` as a realized loss and fully unwind (partial returns leave the residual as still-deployed).
        // Books any surplus over `deployed` first and returns the amount owed to LPs to lock into fees.
        uint256 segregatedDelta;
        (totalDeployed, vaultLiveTvl, segregatedDelta) = PoolLib.returnFromStrategy(
            _strategies,
            principal,
            deployedByLp,
            deployedInto,
            credit,
            feeCheckpointRay,
            _committers[strategyId],
            PoolLib.ReturnState(strategyId, received, totalDeployed, vaultLiveTvl, finalClose)
        );
        segregatedFees += segregatedDelta; // LOCK-FEES: the surplus is owed to LPs, not deployable
        sharedIdle += received;

        emit Events.ClassCapitalReturned(address(this), strategyId, venue, received);
        _assertStrategyConservation(strategyId);
    }

    /// @notice Apply a venue adapter's realized same-chain PnL to `strategyId`'s PnL pool (a valuation mark).
    /// @dev Composer-gated. A gain up-marks (pause-gated); a loss down-marks (always allowed, keeps a frozen
    ///      strategy's price honest). Both directions touch ONLY `pnlPool` (a share-price drift term), never
    ///      `feePerShareRay` / `credit`: this op moves NO tokens, so it must not mint withdrawable credit. That
    ///      would leave `credit` unbacked by `segregatedFees`, breaking the `segregatedFees >= Σ credit`
    ///      invariant `withdraw` relies on. The realized gain becomes withdrawable only when the tokens actually
    ///      return through `returnCapital` (a measured surplus books credit AND raises `segregatedFees` in
    ///      lockstep); routing the mark to `pnlPool` here also avoids double-counting that later surplus.
    /// @param strategyId The strategy whose PnL pool is marked.
    /// @param adapter The venue adapter that realized the PnL (event context).
    /// @param realizedPnL The signed mark: positive up-marks (pause-gated), negative down-marks (always allowed).
    function onAdapterSettle(uint256 strategyId, address adapter, int256 realizedPnL)
        external
        onlyRole(Roles.COMPOSER_ROLE)
        nonReentrant
    {
        _requireStrategy(strategyId);
        if (realizedPnL > 0) {
            _requireNotPaused();
            _requireStrategyNotPaused(strategyId);
            _strategies[strategyId].pnlPool += int256(uint256(realizedPnL));
        } else if (realizedPnL < 0) {
            _strategies[strategyId].pnlPool -= int256(uint256(-realizedPnL));
        }
        emit Events.ClassAdapterSettled(address(this), strategyId, adapter, realizedPnL);
    }

    // ============================================================
    // Mid-swap net settlement (scoped VENUE_SETTLER seam)
    // ============================================================

    /// @notice Sell `amount` of the vault's asset to `to` for `strategyId`'s mid-swap OUT leg, sourcing it from
    ///         the strategy's committers' FREE principal (pro-rata by room). Returns the `Alloc[]` of who sold
    ///         how much, which the adapter threads into the counter vault's `settleVenueCredit` so the proceeds
    ///         are attributed to those committers (ownership-follows-sourcing).
    /// @dev A swap is a principal re-denomination: this leg debits only FREE principal it holds and the single
    ///      shared idle (`amount <= _availableIdle()`, the INV-GLOBAL gate) - so custody stays safe regardless
    ///      of any downstream price. The rolling meter (`_meterVenueOutflow`) bounds the aggregate drain per
    ///      window; a zero limit is a hard stop. Reverts on an unknown/paused strategy, a zero recipient, or a
    ///      zero amount, and reverts (rather than settling unbacked) if the sourced principal is insufficient.
    /// @param strategyId The strategy whose committers source the sold principal.
    /// @param to The recipient of the sold asset (the venue).
    /// @param amount The asset amount sold out.
    /// @return alloc Per-committer breakdown of who sold how much, threaded to the counter vault's credit leg.
    function settleVenueOut(uint256 strategyId, address to, uint256 amount)
        external
        onlyRole(Roles.VENUE_SETTLER_ROLE)
        whenNotPaused
        nonReentrant
        returns (Alloc[] memory alloc)
    {
        _requireActiveStrategy(strategyId);
        require(to != address(0), Errors.ZeroAddress());
        require(amount > 0, Errors.ZeroAmount());

        _meterVenueOutflow(amount);
        (alloc, sharedIdle, vaultLiveTvl) = PoolLib.sellForSwap(
            principal,
            deployedByLp,
            frontHeldPrincipal,
            asyncHeld,
            _committers[strategyId],
            PoolLib.SellState(strategyId, amount, _availableIdle(), sharedIdle, vaultLiveTvl)
        );
        // Rewrite the allocation with fronting attribution BEFORE it leaves this vault. It must happen here,
        // on the sourcing side, because that is where the obligation and the filler's pledged principal live -
        // `settleVenueCredit` runs on the COUNTER vault, which holds no obligation state, so a redirect
        // decided there would resolve to nothing and silently not fire. The loop and its writes are in the
        // library, so they cost this contract no runtime bytes.
        alloc = FrontObligationLib.applyRedirects(_frontObligations, openFrontOf, alloc, strategyId);
        IERC20(asset).safeTransfer(to, amount);

        emit Events.ClassVenueSettled(address(this), strategyId, msg.sender, -int256(amount));
        _assertStrategyConservation(strategyId);
    }

    /// @notice Credit `strategyId`'s mid-swap IN leg to the sourcing committers named in `alloc`. Each LP's
    ///         proceeds (`drawn * refPriceRay`) accrue as their composition in THIS (counter) vault; the spread
    ///         over the summed proceeds is the fee, credited to those LPs.
    /// @dev FOT-safe (measure-what-landed); `require(Σ proceeds <= received)` bounds the credit to the physical
    ///      receipt, so a dishonest `refPriceRay` can shift the principal/fee SPLIT but can never mint unbacked
    ///      principal nor break this vault's `sharedIdle == balance` custody bound. Auto-commits each named LP so
    ///      the conservation fold and their redemption see them. Reverts on an unknown/paused strategy or a zero
    ///      amount. The measured receipt raises `sharedIdle`; the spread raises `segregatedFees` (owed to LPs).
    /// @param strategyId The strategy whose IN leg is credited.
    /// @param amount The asset amount pulled from the caller; the MEASURED receipt is what is booked.
    /// @param alloc The per-committer sourcing breakdown from the counter vault's `settleVenueOut`.
    /// @param refPriceRay The RAY reference price converting each committer's sourced amount into proceeds.
    function settleVenueCredit(uint256 strategyId, uint256 amount, Alloc[] calldata alloc, uint256 refPriceRay)
        external
        onlyRole(Roles.VENUE_SETTLER_ROLE)
        whenNotPaused
        nonReentrant
    {
        _requireActiveStrategy(strategyId);
        require(amount > 0, Errors.ZeroAmount());

        uint256 received = _pullMeasured(msg.sender, amount);
        (uint256 fee, uint256 unallocated) = PoolLib.creditFromSwap(
            composition,
            strategyComposition,
            credit,
            committed,
            _committers[strategyId],
            _committerIndexPlus1[strategyId],
            _committed,
            _commitmentIndexPlus1,
            alloc,
            PoolLib.CreditState(
                strategyId, received, amount, refPriceRay, maxCommittersPerStrategy, maxCommitmentsPerLp
            )
        );
        sharedIdle += received;
        segregatedFees += fee; // LOCK-FEES: the spread is owed to LPs, not deployable
        // The part of the spread no LP was credited with (only when the allocation named no draw at all) is the
        // one part of the reservation owed to nobody, and so the only part an operator may ever release.
        orphanedSegregatedFees += unallocated;
        _reduceVenueOutflow(received);

        emit Events.ClassVenueSettled(address(this), strategyId, msg.sender, int256(received));
        _assertStrategyConservation(strategyId);
    }

    /// @notice Convert the caller's own `composition` (cross-vault swap proceeds) for `strategyId` into its
    ///         `principal` in THIS vault, making it backing and therefore sellable room here.
    /// @dev LP-INITIATED ONLY, deliberately. Conversion raises the caller's exposure, and commitment-shaped
    ///      consent is the LP's to give; no Composer, operator or admin path exists, because none is needed
    ///      and any of them could re-risk an LP without asking.
    ///
    ///      No tokens move (the proceeds already sit in `sharedIdle`), so this is strictly cheaper and safer
    ///      than the `redeemComposition` + `deposit` round trip it replaces: that route pays out and re-pulls
    ///      the same tokens, and its first leg can revert on `_redeemableIdle()` precisely when capital is
    ///      deployed. `vaultLiveTvl` rises because the amount becomes live deployable exposure again, mirroring
    ///      the reduction `sellForSwap` applied when the principal was sold.
    ///
    ///      Reverts `ZeroAmount` on a zero amount, `ExceedsWithdrawable` above the caller's holding,
    ///      `ClassIsPaused` while the strategy is paused (conversion is a RE-risking action, so it is gated
    ///      like the other capital-affecting paths, not like an exit), and `EnforcedPause` while the vault is.
    /// @param strategyId The strategy whose composition is converted.
    /// @param assets The composition amount to reclassify as principal.
    function convertComposition(uint256 strategyId, uint256 assets) external whenNotPaused nonReentrant {
        _requireActiveStrategy(strategyId);

        PoolLib.convertComposition(composition, strategyComposition, principal, strategyId, assets, msg.sender);
        vaultLiveTvl += assets;

        emit Events.CompositionConverted(address(this), strategyId, msg.sender, assets);
        _assertStrategyConservation(strategyId);
    }

    /// @notice Redeem the caller's composition (cross-vault swap proceeds) for `strategyId` to `receiver`.
    ///         Pays this vault's asset, bounded by shared idle (INV-GLOBAL).
    /// @dev Reverts `ZeroAddress` on a zero receiver, `ExceedsWithdrawable` if `assets` exceeds the caller's
    ///      held composition, and `InsufficientSharedIdle` if it exceeds `_redeemableIdle()`. Reduces both the
    ///      caller's `composition` and the strategy aggregate in lockstep (the conservation compare).
    /// @param strategyId The strategy whose composition is redeemed.
    /// @param assets The composition amount to redeem.
    /// @param receiver The account paid this vault's asset.
    /// @return The amount paid out (equal to `assets`).
    function redeemComposition(uint256 strategyId, uint256 assets, address receiver)
        external
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        require(receiver != address(0), Errors.ZeroAddress());
        uint256 held = composition[strategyId][msg.sender];
        require(assets <= held, Errors.ExceedsWithdrawable(msg.sender, assets, held));
        require(assets <= _redeemableIdle(), Errors.InsufficientSharedIdle(assets, _redeemableIdle()));

        composition[strategyId][msg.sender] = held - assets;
        strategyComposition[strategyId] -= assets;
        sharedIdle -= assets;
        IERC20(asset).safeTransfer(receiver, assets);
        return assets;
    }

    /// @notice Tune the per-vault mid-swap net-outflow meter limit (0 is a deliberate hard stop).
    /// @param limit The new per-window outflow budget (0 halts all mid-swap outflow).
    function setVenueOutflowLimit(uint256 limit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        venueOutflowLimit = limit;
        emit Events.VenueOutflowLimitSet(address(this), limit);
    }

    /// @notice The vault's expiry-aware net mid-swap outflow in the live window (0 once the window rolled).
    /// @return The net outflow accrued in the current window, or 0 if the window has elapsed.
    function venueOutflowNet() public view returns (uint256) {
        if (block.timestamp >= venueOutflowWindowStart + VENUE_OUTFLOW_WINDOW) return 0;
        return _venueOutflowNet;
    }

    // ============================================================
    // Hybrid PnL harvest (per strategy; delegatecall into HybridPnLLib)
    // ============================================================

    /// @notice Report the cross-chain in-flight PnL delta for `strategyId`/`route` in `epoch`. Reporter only.
    /// @dev Losses recognize immediately and unclamped; gains clamp + stream at `maxBpsPerEpoch` of the PnL
    ///      base over the epoch. Touches only the strategy's PnL terms, never the capital ledger.
    /// @param strategyId The strategy whose in-flight PnL is reported.
    /// @param epoch The reporting epoch (bounded advance, `MAX_EPOCH_ADVANCE`).
    /// @param route The settlement route the delta is attributed to.
    /// @param xChainDelta The signed in-flight PnL delta since the last report for this route.
    function report(uint256 strategyId, uint64 epoch, bytes32 route, int256 xChainDelta)
        external
        onlyRole(Roles.PNL_REPORTER_ROLE)
        nonReentrant
    {
        HybridPnLLib.report(
            _strategies,
            _routeReportedLoss,
            _routeReportedGain,
            strategyId,
            epoch,
            route,
            xChainDelta,
            _vaultNow(),
            paused(),
            epochLength,
            maxBpsPerEpoch
        );
    }

    /// @notice The `(strategy, route, settlementId)` idempotency key a bridge settlement consumes.
    /// @param strategyId The strategy component of the key.
    /// @param route The settlement route component of the key.
    /// @param settlementId The bridge settlement id (GUID) component of the key.
    /// @return The keccak256 idempotency key.
    function settlementKey(uint256 strategyId, bytes32 route, bytes32 settlementId) public pure returns (bytes32) {
        return keccak256(abi.encode(strategyId, route, settlementId));
    }

    /// @notice Whether a bridge settlement has already been consumed (one-shot, forever).
    /// @param strategyId The strategy component of the key.
    /// @param route The settlement route component of the key.
    /// @param settlementId The bridge settlement id (GUID) component of the key.
    /// @return True if the settlement has already been reconciled.
    function settlementConsumed(uint256 strategyId, bytes32 route, bytes32 settlementId) external view returns (bool) {
        return _settlementConsumed[settlementKey(strategyId, route, settlementId)];
    }

    /// @notice Reconcile a strategy/route's reported gain against the settled delta on bridge landing.
    /// @dev Composer-gated and one-shot idempotent on `settlementId` (the key above). Reconciles the reported
    ///      gain/loss against the true settled delta within `reconcileToleranceBps`.
    /// @param strategyId The strategy being reconciled.
    /// @param route The settlement route being reconciled.
    /// @param settlementId The bridge landing id; the reconciliation is consumed one-shot under this id.
    /// @param settledDelta The true settled PnL delta the reported figure is reconciled against.
    function onBridgeSettle(uint256 strategyId, bytes32 route, bytes32 settlementId, int256 settledDelta)
        external
        onlyRole(Roles.COMPOSER_ROLE)
        whenNotPaused
        nonReentrant
    {
        HybridPnLLib.onBridgeSettle(
            _strategies,
            _settlementConsumed,
            _routeReportedGain,
            _routeReportedLoss,
            strategyId,
            route,
            settlementId,
            settledDelta,
            _vaultNow(),
            reconcileToleranceBps
        );
    }

    /// @notice Guardian emergency response: strip `strategyId`'s un-vested reporter gain and pause it.
    /// @dev Crystallizes the already-vested gain (keeping honest value), zeroes the un-vested remainder, sets
    ///      `reporterFrozen`, and pauses the strategy. The one lever that reverses a bad in-flight report.
    /// @param strategyId The strategy to veto.
    /// @param reason Human-readable veto reason (event context only).
    function guardianVeto(uint256 strategyId, string calldata reason) external onlyRole(Roles.GUARDIAN_ROLE) {
        _requireStrategy(strategyId);
        Strategy storage s = _strategies[strategyId];
        VaultMath.crystallizeVestedGain(s, _vaultNow());
        s.vestingGain = 0;
        s.reporterFrozen = true;
        _pauseStrategy(strategyId);
        emit Events.ClassGuardianVeto(address(this), strategyId, msg.sender, reason);
    }

    /// @notice Update the vault-level hybrid-PnL safety seeds (vault-uniform).
    /// @dev Bounds enforced: `epoch` in `[MIN_EPOCH_LENGTH, MAX_EPOCH_LENGTH]`, `maxBps <=
    ///      MAX_BPS_PER_EPOCH_CEILING`, `toleranceBps <= 10_000`. These caps are the ceiling on how fast a
    ///      report can stream gain and how loose bridge reconciliation may be, so admin cannot widen them past
    ///      the hard constants.
    /// @param epoch The gain-streaming epoch length in seconds.
    /// @param maxBps The per-epoch gain clamp in bps of the PnL base.
    /// @param toleranceBps The bridge-reconciliation tolerance in bps.
    function setPnLParams(uint64 epoch, uint16 maxBps, uint16 toleranceBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(
            epoch >= MIN_EPOCH_LENGTH && epoch <= MAX_EPOCH_LENGTH,
            Errors.InvalidEpochLength(epoch, MIN_EPOCH_LENGTH, MAX_EPOCH_LENGTH)
        );
        require(maxBps <= MAX_BPS_PER_EPOCH_CEILING, Errors.MaxBpsAboveCeiling(maxBps, MAX_BPS_PER_EPOCH_CEILING));
        require(toleranceBps <= 10_000, Errors.InvalidReconcileTolerance(toleranceBps));
        epochLength = epoch;
        maxBpsPerEpoch = maxBps;
        reconcileToleranceBps = toleranceBps;
        emit Events.ClassPnLParamsSet(address(this), epoch, maxBps, toleranceBps);
    }

    /// @notice Raise/lower the bounded committer + commitment set sizes (layout-safe tunables).
    /// @dev Both must be non-zero (a zero bound would brick every new commitment). The bounds cap the O(n)
    ///      pro-rata source and backing loops, so raising them trades gas for larger committer sets.
    /// @param maxCommitters The new per-strategy committer-set cap.
    /// @param maxCommitments The new per-LP commitment-set cap.
    function setSetBounds(uint256 maxCommitters, uint256 maxCommitments) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(maxCommitters > 0 && maxCommitments > 0, Errors.ZeroAmount());
        maxCommittersPerStrategy = maxCommitters;
        maxCommitmentsPerLp = maxCommitments;
        emit Events.SetBoundsUpdated(address(this), maxCommitters, maxCommitments);
    }

    // ============================================================
    // ERC-7540 async redeem (deployed-principal exits)
    // ============================================================
    //
    // A withdraw of FREE principal is
    // synchronous (see `withdraw`); a redeem of principal currently DEPLOYED on the LP's behalf
    // (`deployedByLp[owner] > 0`) cannot be paid from idle, so it goes async. `requestRedeem` ESCROWS the claim
    // against the LP's principal (`asyncHeld`), so the freed capital is reserved for the redeemer and not
    // withdrawn / re-sourced out from under them; `fulfillRedeem` is the operator-attested strike (Composer
    // spine); `claimRedeem` pays it once the capital has returned to `sharedIdle` (or at the never-trapped
    // timeout). `strategyId` is a routing label (one pool).

    /// @notice Request an async redeem of `assets` of `owner`'s currently-DEPLOYED principal, claimable by
    ///         `controller`. Escrows the claim (`asyncHeld`); fulfilled as the backing capital returns.
    /// @dev Only the owner may request (`msg.sender == owner`). Bounds `assets` to deployed principal not
    ///      already escrowed by another pending request (`deployedByLp - asyncHeld`), then adds it to
    ///      `asyncHeld` so two requests never double-pledge the same deployed capital.
    /// @param strategyId The strategy the redeem is routed to (a routing label; one pool).
    /// @param assets The fixed amount of deployed principal to redeem.
    /// @param controller The account authorized to later claim the request.
    /// @param owner The principal owner; must equal the caller.
    /// @return requestId The id of the created redeem request.
    function requestRedeem(uint256 strategyId, uint256 assets, address controller, address owner)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 requestId)
    {
        _requireStrategy(strategyId);
        require(msg.sender == owner, Errors.PrincipalUnauthorized(msg.sender, owner));
        // Can only async-redeem deployed principal not already escrowed by another pending request.
        // Saturating: a realized strategy loss can write `deployedByLp` down below an already-escrowed
        // `asyncHeld` (from an earlier pending request against the same owner), and this must not underflow
        // and permanently brick every future requestRedeem for that owner - mirrors `claimRedeem`'s
        // saturating `returnedPrincipal` above.
        uint256 deployed = deployedByLp[owner];
        uint256 held = asyncHeld[owner];
        uint256 redeemableDeployed = deployed > held ? deployed - held : 0;
        requestId = ++nextRequestId;
        AsyncRedeemLib.request(
            redeemRequests,
            settlementRoute,
            routeTimeout,
            strategyId,
            assets,
            controller,
            owner,
            requestId,
            redeemableDeployed
        );
        asyncHeld[owner] += assets;
    }

    /// @notice Attest that capital backing `requestId` is free and lock the owed amount. Composer-gated.
    /// @param requestId The async-redeem request to fulfil.
    function fulfillRedeem(uint256 requestId) external onlyRole(Roles.COMPOSER_ROLE) whenNotPaused nonReentrant {
        AsyncRedeemLib.fulfill(redeemRequests, requestId);
    }

    /// @notice Claim a fulfilled or timed-out async redeem, paying the escrowed principal from shared idle.
    /// @dev Requires the freed capital to be present (`assets <= redeemableIdle`, so a not-yet-returned claim
    ///      reverts and is retried). Releases the escrow and reduces the owner's principal by the paid amount, so
    ///      the per-LP cap and pool solvency both hold.
    /// @dev `whenNotPaused` because this is an asset-OUTFLOW path: it transfers `asset` out of the vault. A
    ///      pause has to stop every outflow or it does not contain an incident, and this was the one outflow
    ///      that a paused vault still permitted. The escrow is not lost while paused: the request stays
    ///      unclaimed and the claim is retried after unpause, and the per-route timeout is bounded by
    ///      `GLOBAL_MAX_TIMEOUT`, so pausing delays a claim rather than trapping it.
    /// @param requestId The async-redeem request to settle.
    /// @param receiver Account paid the freed principal.
    /// @return assets Amount actually paid out (may be below the escrow when a strategy loss cut into principal).
    function claimRedeem(uint256 requestId, address receiver)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 assets)
    {
        require(receiver != address(0), Errors.ZeroAddress());
        address reqOwner = redeemRequests[requestId].owner;
        // Pay only from principal that has RETURNED (`principal - deployedByLp`) AND is not reserved for a
        // committed cross-chain front (`- frontHeldPrincipal`). Omitting the fronting hold would let a claim
        // drain principal promised to a Committed front; when that front later releases (dropping principal by
        // its amount) the per-LP cap `deployedByLp <= principal` would break by the claimed amount. Saturating
        // so a strategy loss that already bit into principal cannot underflow here.
        uint256 reserved = deployedByLp[reqOwner] + frontHeldPrincipal[reqOwner];
        uint256 returnedPrincipal = principal[reqOwner] > reserved ? principal[reqOwner] - reserved : 0;
        address owner;
        uint256 escrowReleased;
        (assets, owner,, escrowReleased) =
            AsyncRedeemLib.claim(redeemRequests, requestId, _redeemableIdle(), returnedPrincipal, principal[reqOwner]);
        // Release the FULL escrow (a loss may make `assets < escrowReleased`; the redeem is terminal either way),
        // but cut principal / idle / exposure by only the amount actually paid.
        asyncHeld[owner] -= escrowReleased;
        principal[owner] -= assets;
        sharedIdle -= assets;
        _reduceExposure(assets);
        if (assets > 0) IERC20(asset).safeTransfer(receiver, assets);
    }

    /// @notice Bind `strategyId`'s async redeems to a settlement `route` (the per-route claim-timeout key).
    ///         Admin-only.
    /// @param strategyId The strategy to bind.
    /// @param route The settlement route key its async redeems resolve their timeout through.
    function setSettlementRoute(uint256 strategyId, bytes32 route) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _requireStrategy(strategyId);
        settlementRoute[strategyId] = route;
        emit Events.SettlementRouteSet(address(this), strategyId, route);
    }

    /// @notice Set a `route`'s async-redeem claim timeout (bounded by `GLOBAL_MAX_TIMEOUT`; 0 falls back to
    ///         that ceiling). Admin-only.
    /// @dev Reverts `InvalidRouteTimeout` above the global ceiling, so no route can push a claim past the
    ///      never-trapped bound.
    /// @param route The settlement route to configure.
    /// @param timeout The claim timeout in seconds (0 falls back to `GLOBAL_MAX_TIMEOUT`).
    function setRouteTimeout(bytes32 route, uint64 timeout) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(timeout <= GLOBAL_MAX_TIMEOUT, Errors.InvalidRouteTimeout(timeout, GLOBAL_MAX_TIMEOUT));
        routeTimeout[route] = timeout;
    }

    // ============================================================
    // Cross-chain LP fronting (source lock lifecycle + destination landing credit)
    // ============================================================
    //
    // Lock-before-front. Under the shared pool a front escrows the LP's PRINCIPAL claim (not a transferable
    // share): `requestFrontLock` holds `amount` out of the owner's free principal, and `commitFrontLock`
    // hard-locks it from shared availability (`frontReservedAssets`) so the same idle is never double-promised.
    // The lifecycle is Locked -> Committed -> Released, and a cancel is never trapped while Locked. The owner
    // authorizes their own front.

    /// @notice Escrow `amount` of `owner`'s principal for cross-chain front `frontId`. State -> Locked. Holds
    ///         the amount out of the owner's free principal (a non-transferable principal claim). Owner-only.
    /// @dev Reverts `PrincipalUnauthorized` unless the caller is the owner, and `ExceedsWithdrawable` if the
    ///      amount exceeds the owner's free principal. Adds to `frontHeldPrincipal` so the amount leaves the
    ///      owner's free principal but not yet the shared idle (that hard-reservation happens at commit).
    /// @param strategyId The strategy the front is attributed to.
    /// @param amount The principal amount to lock.
    /// @param owner The principal owner; must equal the caller.
    /// @param frontId The unique front identifier this lock is created under.
    function requestFrontLock(uint256 strategyId, uint256 amount, address owner, bytes32 frontId)
        external
        whenNotPaused
        nonReentrant
    {
        _requireStrategy(strategyId);
        require(msg.sender == owner, Errors.PrincipalUnauthorized(msg.sender, owner));
        require(amount <= freePrincipal(owner), Errors.ExceedsWithdrawable(owner, amount, freePrincipal(owner)));
        FrontLockLib.lock(
            frontLocks, frontHeldPrincipal, strategyId, amount, owner, frontId, frontingReleaseLimit, frontLockTimeout
        );
    }

    /// @notice Harden `frontId` from Locked to Committed AND hard-lock its principal from shared availability.
    ///         Composer-gated.
    /// @dev Adds the front amount to `frontReservedAssets`, removing it from deployable idle so the same idle
    ///      can never be double-promised to a front and a same-chain swap. The library asserts the amount is
    ///      covered by `_availableIdle()` before flipping the state.
    /// @param strategyId The strategy the front belongs to.
    /// @param frontId The front to harden from Locked to Committed.
    function commitFrontLock(uint256 strategyId, bytes32 frontId) external onlyRole(Roles.COMPOSER_ROLE) {
        uint256 reserved = FrontLockLib.commit(frontLocks, strategyId, frontId, _availableIdle());
        frontReservedAssets += reserved;
    }

    /// @notice Meter and release `frontId` toward the bridge. Committed -> Released (terminal). The fronted
    ///         principal leaves this chain: the owner's principal, the reservation, and shared idle all drop by
    ///         it. The library validates/meters/flips; the vault moves the principal + transfers.
    /// @dev The struck assets are transferred to `msg.sender` (the Composer) for the bridge. The rolling
    ///      fronting-release meter bounds the aggregate outflow per window.
    /// @param strategyId The strategy the front belongs to.
    /// @param frontId The front to release toward the bridge.
    /// @return assets The principal amount released and transferred out.
    function releaseFrontToBridge(uint256 strategyId, bytes32 frontId)
        external
        onlyRole(Roles.COMPOSER_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 assets)
    {
        (assets, frontingReleaseWindowStart, _frontingReleaseNet) = FrontLockLib.release(
            frontLocks,
            frontHeldPrincipal,
            principal,
            strategyId,
            frontId,
            sharedIdle,
            frontingReleaseLimit,
            FRONTING_RELEASE_WINDOW,
            frontingReleaseWindowStart,
            _frontingReleaseNet
        );
        frontReservedAssets -= assets;
        sharedIdle -= assets;
        _reduceExposure(assets);
        IERC20(asset).safeTransfer(msg.sender, assets);
    }

    /// @notice Recover the escrowed principal if `frontId` was never committed. Locked -> Cancelled (terminal).
    ///         LP-A never-trapped exit, reachable ONLY while Locked (before any front exists). Owner or admin.
    /// @dev Releases the owner's `frontHeldPrincipal` hold. A non-admin caller must be the front owner
    ///      (`FrontUnauthorized` otherwise); admin may cancel any Locked front as an escape hatch. Because it is
    ///      reachable only while Locked, no committed reservation or bridged capital is ever unwound here.
    /// @param frontId The Locked front to cancel.
    function cancelFrontLock(bytes32 frontId) external nonReentrant {
        address owner =
            FrontLockLib.cancel(frontLocks, frontHeldPrincipal, frontId, hasRole(DEFAULT_ADMIN_ROLE, msg.sender));
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            require(msg.sender == owner, Errors.FrontUnauthorized(frontId, msg.sender));
        }
    }

    /// @notice Admin/guardian abort of a `Committed` front: unwinds it back to the owner's free principal,
    ///         releasing both the hard reservation and the principal hold. Committed -> Cancelled (terminal).
    /// @dev The escape hatch a Committed front otherwise lacks: `cancelFrontLock` only ever accepts Locked,
    ///      and `releaseFrontToBridge` can still be blocked (bridge/operator flow stuck, a still-live
    ///      guardian veto, etc.) even though `setFrontingConfig(0, ...)` alone no longer blocks it (the
    ///      `_meter` exemption in `FrontLockLib` handles that case). No principal ever leaves the vault here:
    ///      a pure accounting unwind, the reverse of `commitFrontLock`.
    /// @param frontId The Committed front to abort.
    function abortCommittedFront(bytes32 frontId) external nonReentrant {
        _requireAdminOrGuardian();
        uint256 amount = FrontLockLib.abort(frontLocks, frontHeldPrincipal, frontId);
        frontReservedAssets -= amount;
    }

    /// @notice Record one filler's leg of a cross-chain front: their pledged principal stands in for the
    ///         beneficiary's not-yet-arrived capital, and the proceeds of that pledge are redirected to the
    ///         beneficiary until settlement returns it.
    /// @dev Composer-gated, so the caller is the backend-signed op path. Filler CONSENT is checked there
    ///      rather than here: the opt-in registry is not wired to this vault, and adding it would cost storage
    ///      plus a setter on a contract already near the EIP-170 cap, while the Composer has ample headroom.
    ///
    ///      Committing the beneficiary happens at OPEN rather than at settlement, deliberately.
    ///      `creditFromSwap` auto-commits any credited LP and reverts `CommitterSetFull` at the cap; if that
    ///      revert landed at settlement the bridged tokens would already have arrived and could not be booked -
    ///      stranded capital. Failing here costs nothing, because nothing has moved yet.
    /// @param strategyId The destination strategy the front is attributed to.
    /// @param frontId The cross-chain front identifier, shared with the source chain's lock.
    /// @param filler The committer standing in; must not be the beneficiary.
    /// @param beneficiary The source-chain LP whose capital is bridging in.
    /// @param pledged The filler's allocation, mirroring the backend reservation row.
    /// @param feeOwed The filler's compensation in this vault's asset.
    function openFrontObligation(
        uint256 strategyId,
        bytes32 frontId,
        address filler,
        address beneficiary,
        uint256 pledged,
        uint256 feeOwed
    ) external onlyRole(Roles.COMPOSER_ROLE) whenNotPaused nonReentrant {
        _requireActiveStrategy(strategyId);
        FrontObligationLib.open(
            _frontObligations,
            openFrontOf,
            committed,
            _committers[strategyId],
            _committerIndexPlus1[strategyId],
            _committed,
            _commitmentIndexPlus1,
            pendingFrontCredits,
            FrontObligationLib.OpenParams(
                frontId,
                strategyId,
                filler,
                beneficiary,
                pledged,
                feeOwed,
                maxCommittersPerStrategy,
                maxCommitmentsPerLp
            )
        );
    }

    /// @notice Credit the MEASURED bridge landing `amount` for front `frontId` to shared idle. One-shot. Any
    ///         shortfall against `lockedAmount` (the destination obligation the landing had to cover) is
    ///         written down as a realized loss instead of silently vanishing.
    /// @dev One-shot per `(strategyId, frontId, settlementId)` via the settlement-consumed set, so a landing
    ///      can never be double-credited. The measured receipt (FOT-safe) is what raises `sharedIdle`.
    ///      `lockedAmount` cannot be derived on-chain (this vault has no visibility into the SOURCE chain's
    ///      `FrontLock` state - a different chain entirely) - it is relayed by the Composer. A shortfall
    ///      (`lockedAmount > received`) is booked as a realized loss to the strategy's `pnlPool`; crediting the
    ///      specific fronting LP for it is a separate, later-scoped make-whole feature, not this safety write-down.
    /// @param strategyId The strategy the front belongs to.
    /// @param frontId The front whose destination landing is credited.
    /// @param settlementId The bridge landing id; the credit is consumed one-shot under this id.
    /// @param amount The amount pulled from the caller; the MEASURED receipt is what is booked.
    /// @param lockedAmount The destination-side OBLIGATION this landing had to cover - the filler's principal
    ///        plus their configured fee - and the basis any shortfall is measured against.
    ///
    ///        NOT the full amount struck on the source chain. The source release also carries bridge-cost
    ///        headroom, which the bridge legitimately consumes in transit; measuring the shortfall against
    ///        that larger figure would book the ordinary cost of bridging as a realized loss to `pnlPool` on
    ///        every single job. An earlier version of this comment described it as the released amount, which
    ///        would make a caller "correcting" itself to match introduce exactly that systematic false loss.
    ///
    ///        The contract cannot verify which figure it was given - it has no view of the source chain - so
    ///        this is a semantic contract with the Composer, stated here rather than enforced.
    function creditFrontLanding(
        uint256 strategyId,
        bytes32 frontId,
        bytes32 settlementId,
        uint256 amount,
        uint256 lockedAmount
    ) external onlyRole(Roles.COMPOSER_ROLE) whenNotPaused nonReentrant {
        _requireStrategy(strategyId);
        uint256 received = FrontLockLib.credit(
            _settlementConsumed, strategyId, frontId, settlementId, amount, asset, FRONT_LANDING_DOMAIN
        );
        sharedIdle += received;

        // Resolve every filler leg out of the MEASURED landing: restore each filler what the redirect took from
        // them (`redirected`, not `pledged` - so they are whole by construction rather than by reconciling
        // against numbers this vault cannot verify), pay each their fee into `credit`, and credit the residual
        // to the beneficiary as composition. `segregatedFees` rises by the fees ACTUALLY paid to preserve
        // `segregatedFees >= sum(credit)`, and locks them out of deployable idle so a later swap cannot source
        // tokens already owed. Every payout is clamped to the measured landing rather than refused when it
        // falls short, which is what keeps the write-down below reachable: it sits downstream of this call and
        // exists for precisely the input a refusal here would never let through.
        segregatedFees += FrontObligationLib.resolve(
            _frontObligations,
            openFrontOf,
            principal,
            credit,
            composition,
            strategyComposition,
            pendingFrontCredits,
            FrontObligationLib.ResolveParams(frontId, received, false)
        );

        if (lockedAmount > received) {
            uint256 shortfall = lockedAmount - received;
            _strategies[strategyId].pnlPool -= int256(shortfall);
            emit Events.FrontLandingShortfall(address(this), strategyId, frontId, settlementId, shortfall);
        }
    }

    /// @notice Resolve a front whose destination landing will not arrive: repay each filler out of `amount`,
    ///         release the exclusivity slot and the beneficiary's committer hold, and mark every leg terminal.
    ///         `amount` may be zero, which releases the state without moving value.
    /// @dev Admin or guardian, mirroring `abortCommittedFront` on the source leg. NOT a Composer capability:
    ///      the backend signer authorises swap mechanics and no value decision, and this ends the
    ///      beneficiary's claim on a landing that may still be in flight.
    ///
    ///      Without it a front that never lands is terminal in the wrong direction. `resolve` is the only
    ///      writer of obligation state and its only other caller needs a real bridge landing, so the filler's
    ///      redirected principal stays unrecoverable, `openFrontOf` stays set and bars that filler from the
    ///      strategy for good, and the beneficiary keeps a slot in the bounded committer set that nothing can
    ///      free. No principal is created here: fillers are repaid strictly out of the measured receipt, so an
    ///      unfunded unwind returns the slots and books the filler's loss rather than minting a repayment.
    ///      Not `whenNotPaused` - an escape hatch that a pause disables is not an escape hatch.
    /// @param frontId The front to resolve without a landing.
    /// @param amount Tokens pulled from the caller to repay the fillers with; the MEASURED receipt is booked.
    function abortFrontObligation(bytes32 frontId, uint256 amount) external nonReentrant {
        _requireAdminOrGuardian();
        uint256 received;
        if (amount > 0) {
            received = _pullMeasured(msg.sender, amount);
            sharedIdle += received;
        }
        segregatedFees += FrontObligationLib.resolve(
            _frontObligations,
            openFrontOf,
            principal,
            credit,
            composition,
            strategyComposition,
            pendingFrontCredits,
            FrontObligationLib.ResolveParams(frontId, received, true)
        );
    }

    /// @notice Tune the fronting config: the release meter `limit` (0 disables fronting) and the LP-A
    ///         self-cancel window `lockTimeout` (bounded by `GLOBAL_MAX_TIMEOUT`).
    /// @dev Reverts `InvalidRouteTimeout` if `lockTimeout` exceeds the global ceiling.
    /// @param limit The per-window fronting-release budget (0 disables new releases).
    /// @param lockTimeout The LP self-cancel window in seconds (bounded by `GLOBAL_MAX_TIMEOUT`).
    function setFrontingConfig(uint256 limit, uint64 lockTimeout) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(lockTimeout <= GLOBAL_MAX_TIMEOUT, Errors.InvalidRouteTimeout(lockTimeout, GLOBAL_MAX_TIMEOUT));
        frontingReleaseLimit = limit;
        frontLockTimeout = lockTimeout;
        emit Events.FrontingReleaseLimitSet(address(this), limit);
    }

    /// @notice Admin/guardian reconciliation: release `amount` of the ORPHANED segregated reservation back to
    ///         deployable idle.
    /// @dev Pure accounting correction, no tokens move. Exists for a `segregatedFees` amount that was reserved
    ///      without a matching claimable `credit` ever being minted for it: real idle with no on-chain path to
    ///      release it otherwise.
    ///
    ///      Bounded by `orphanedSegregatedFees`, NOT by `segregatedFees`. The rest of the reservation backs LP
    ///      value in one of two forms - `credit` already crystallized, or an accumulator bump not yet
    ///      crystallized - and both are consumed later by a subtraction from `segregatedFees`. Releasing either
    ///      makes that subtraction under-flow on the LP's own withdrawal, and no volume of later fee flow
    ///      repairs it, because every new fee raises `credit` and `segregatedFees` in lockstep and so conserves
    ///      the deficit. A bound at outstanding `credit` alone would still permit the pending-accrual half of
    ///      that, which is why the releasable part is tracked forward from where it is created instead.
    /// @param amount The amount to release; must not exceed the orphaned portion of the reservation.
    function reconcileSegregatedFees(uint256 amount) external {
        _requireAdminOrGuardian();
        uint256 releasable = orphanedSegregatedFees;
        require(amount <= releasable, Errors.ExceedsSegregatedFees(amount, releasable));
        orphanedSegregatedFees = releasable - amount;
        segregatedFees -= amount;
        emit Events.SegregatedFeesReconciled(address(this), amount);
    }

    // ============================================================
    // Internals - commitment set management
    // ============================================================

    /// @dev Apply one commitment change for `lp`. A commit (`backing == true`) requires the LP to hold real
    ///      principal at commit time; a clear is always allowed. The principal test gates ENTRY only and is
    ///      never re-evaluated, so it does not keep the bounded committer set funded: a committer that later
    ///      withdraws to zero principal holds its slot until it uncommits, and the same capital can be cycled
    ///      through many slots. A zero-principal member contributes 0 to both the backing ceiling and the
    ///      drawable room, so it cannot dilute a source, but it does consume one of
    ///      `maxCommittersPerStrategy` and a full set blocks new commitments AND the mid-swap auto-commit of
    ///      sourcing LPs. Evicting such a member needs a mechanism that does not exist here yet.
    /// @param lp The LP whose commitment changes.
    /// @param strategyId The strategy committed to / uncommitted from.
    /// @param backing True to commit, false to clear.
    function _setCommitment(address lp, uint256 strategyId, bool backing) internal {
        // Backing adds `lp` to the strategy's bounded committer set (iterated by the pro-rata source pass and
        // the conservation fold, so its size is capped). Real principal is required to ENTER the set and is
        // never re-tested, so this prices a slot at commit time but does not hold it funded: a member that
        // withdraws to zero keeps its slot until it uncommits. Clearing a commitment is always allowed (an LP
        // that fully withdrew must still be able to uncommit).
        if (backing) require(principal[lp] > 0, Errors.NoPrincipalToCommit(lp));
        PoolLib.setCommitment(
            _strategies,
            committed,
            deployedInto,
            composition,
            pendingFrontCredits,
            _committers[strategyId],
            _committerIndexPlus1[strategyId],
            _committed[lp],
            _commitmentIndexPlus1[lp],
            lp,
            backing,
            PoolLib.SetRefs(strategyId, maxCommittersPerStrategy, maxCommitmentsPerLp)
        );
    }

    // ============================================================
    // Internals - guards, meters, clock
    // ============================================================

    /// @dev Pull `amount` from `from`, returning the amount PHYSICALLY received (FOT-safe). Measures the vault's
    ///      balance delta rather than trusting `amount`, so a fee-on-transfer / rebasing asset can never book
    ///      more than actually landed. Reverts `ZeroAmount` on a zero measured receipt.
    /// @param from The account tokens are pulled from.
    /// @param amount The requested transfer amount (the actual receipt may be lower for FOT tokens).
    /// @return received The measured amount the vault actually received.
    function _pullMeasured(address from, uint256 amount) internal returns (uint256 received) {
        uint256 before = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(from, address(this), amount);
        received = IERC20(asset).balanceOf(address(this)) - before;
        require(received > 0, Errors.ZeroAmount());
    }

    /// @dev Shared idle available to deploy / mid-swap sell: `sharedIdle` less the hard fronting reservation
    ///      and the segregated fees (LOCK-FEES). Neither can be sourced by a capital move; the fronting
    ///      reservation is promised to Committed fronts, the fees are owed to LPs as `credit`. Floors at 0.
    /// @return The idle a capital move may source (INV-GLOBAL numerator).
    function _availableIdle() internal view returns (uint256) {
        uint256 reserved = frontReservedAssets + segregatedFees;
        return sharedIdle > reserved ? sharedIdle - reserved : 0;
    }

    /// @dev Idle available to a REDEEMER (withdraw of free principal + credit, or a composition claim): all of
    ///      `sharedIdle` less only the fronting reservation. Includes the segregated fees, which a withdraw of
    ///      credit legitimately draws (they are excluded from DEPLOYABLE idle, not from redeemable idle). Floors
    ///      at 0.
    /// @return The idle a redeemer may draw.
    function _redeemableIdle() internal view returns (uint256) {
        return sharedIdle > frontReservedAssets ? sharedIdle - frontReservedAssets : 0;
    }

    /// @dev Release `assets` of principal from the vault live-TVL meter on an exit (bounded at zero).
    /// @param assets The principal amount leaving the vault (subtracted from `vaultLiveTvl`, floored at 0).
    function _reduceExposure(uint256 assets) internal {
        uint256 t = vaultLiveTvl;
        vaultLiveTvl = t > assets ? t - assets : 0;
    }

    /// @dev Add `amount` to the vault's rolling net-outflow meter (fixed-grid window). A ZERO limit is a
    ///      HARD STOP, not "unlimited": `newNet <= limit` with `limit == 0` rejects any non-zero outflow. When
    ///      the window has elapsed, `start` snaps FORWARD to the fixed grid point at or before `now`
    ///      (`start + floor((now - start) / WINDOW) * WINDOW`), NOT to `block.timestamp` itself. Anchoring to
    ///      `block.timestamp` (a tumbling reset) lets whoever happens to trigger the reset transaction choose
    ///      the new window's phase, so a caller could draw the full limit in the last instant of one window
    ///      and immediately trigger a reset that starts a fresh window right then too - repeatable every
    ///      cycle for a SUSTAINED ~2x rate, not just a one-time boundary straddle. Fixed-grid points are
    ///      independent of transaction timing, so at most one extra full draw is ever possible, once, after
    ///      which the grid's next boundary is still a full `WINDOW` away.
    /// @param amount The outflow to record; reverts `VenueOutflowMeterExceeded` if it breaches the window cap.
    function _meterVenueOutflow(uint256 amount) internal {
        uint256 limit = venueOutflowLimit;
        uint256 start = venueOutflowWindowStart;
        uint256 net;
        if (block.timestamp >= start + VENUE_OUTFLOW_WINDOW) {
            // The divide-then-multiply is intentional integer flooring: it snaps `start` forward to the
            // most recent whole-WINDOW boundary, so the grid stays fixed-phase. Exact by construction, not a
            // precision loss.
            // slither-disable-next-line divide-before-multiply
            start += ((block.timestamp - start) / VENUE_OUTFLOW_WINDOW) * VENUE_OUTFLOW_WINDOW;
            net = 0;
        } else {
            net = _venueOutflowNet;
        }
        uint256 newNet = net + amount;
        require(newNet <= limit, Errors.VenueOutflowMeterExceeded(amount, limit > net ? limit - net : 0));
        venueOutflowWindowStart = start;
        _venueOutflowNet = newNet;
    }

    /// @dev Reduce the rolling net-outflow accumulator by an inflow (floored at 0; live window only). A
    ///      counter-leg credit nets against the outflow it offsets so a round-trip swap does not consume budget;
    ///      an inflow after the window rolled is ignored (there is nothing to offset).
    /// @param amount The inflow to net against the current window's outflow.
    function _reduceVenueOutflow(uint256 amount) internal {
        if (block.timestamp >= venueOutflowWindowStart + VENUE_OUTFLOW_WINDOW) return;
        uint256 net = _venueOutflowNet;
        _venueOutflowNet = net > amount ? net - amount : 0;
    }

    /// @dev The vault clock: wall-clock minus every second the vault has spent paused. Monotone (while paused
    ///      it reads `vaultPausedAt`, so it does not advance during a freeze). All vesting/clamp windows are
    ///      measured against this so a pause never streams gain into the price.
    /// @return The pause-adjusted vault time.
    function _vaultNow() internal view returns (uint256) {
        uint256 raw = paused() ? vaultPausedAt : block.timestamp;
        return raw - vaultFrozenSeconds;
    }

    /// @dev Mark a strategy individually paused, stamping `pausedAt` on the vault clock. Idempotent (an
    ///      already-paused strategy is a no-op, so `pausedAt` is not overwritten and its freeze span is exact).
    /// @param strategyId The strategy to pause.
    function _pauseStrategy(uint256 strategyId) internal {
        Strategy storage s = _strategies[strategyId];
        if (s.paused) return;
        s.paused = true;
        s.pausedAt = uint64(_vaultNow());
        emit Events.ClassPaused(address(this), strategyId);
    }

    /// @dev Revert `ClassNotRegistered` unless `strategyId` exists. Protects every strategy-scoped path from
    ///      operating on an unregistered id.
    /// @param strategyId The strategy that must exist.
    function _requireStrategy(uint256 strategyId) internal view {
        require(_strategies[strategyId].exists, Errors.ClassNotRegistered(strategyId));
    }

    /// @dev Revert `ClassIsPaused` if `strategyId` is individually paused. Guards ops that must not run on a
    ///      frozen strategy (deploys, mid-swap settles, up-marks).
    /// @param strategyId The strategy that must not be paused.
    function _requireStrategyNotPaused(uint256 strategyId) internal view {
        require(!_strategies[strategyId].paused, Errors.ClassIsPaused(strategyId));
    }

    /// @dev Require `strategyId` both EXISTS and is NOT individually paused - the standing precondition every
    ///      strategy-scoped capital op shares. Reverts `ClassNotRegistered` first (existence), then `ClassIsPaused`,
    ///      exactly as the inline `_requireStrategy` + `_requireStrategyNotPaused` pair it replaces. Kept in this
    ///      order so an unregistered id never reads the (default-false) `paused` flag as "active".
    /// @param strategyId The strategy that must be registered and unpaused.
    function _requireActiveStrategy(uint256 strategyId) internal view {
        require(_strategies[strategyId].exists, Errors.ClassNotRegistered(strategyId));
        require(!_strategies[strategyId].paused, Errors.ClassIsPaused(strategyId));
    }

    /// @dev Revert `NotAdminOrGuardian` unless the caller holds `DEFAULT_ADMIN_ROLE` or `Roles.GUARDIAN_ROLE`.
    ///      Shared by the two last-resort accounting corrections either role may trigger
    ///      (`abortCommittedFront`, `reconcileSegregatedFees`).
    function _requireAdminOrGuardian() internal view {
        require(
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender) || hasRole(Roles.GUARDIAN_ROLE, msg.sender),
            Errors.NotAdminOrGuardian(msg.sender)
        );
    }

    /// @dev INV-CONSERVATION, asserted on every settle. Delegatecalls into `PoolLib.assertConservation`
    ///      (moved out of AssetVault verbatim in the size-reduction pass; two per-strategy folds over this
    ///      vault's committers - committed-ship principal and cross-vault swap composition - maintained in
    ///      lockstep). Across the pair, each vault asserts its own asset's leg; the two legs reconstruct the
    ///      LP's full position.
    /// @param strategyId The strategy whose two conservation folds are re-verified after a settle.
    function _assertStrategyConservation(uint256 strategyId) internal view {
        PoolLib.assertConservation(
            deployedInto,
            composition,
            _committers[strategyId],
            strategyId,
            _strategies[strategyId].deployed,
            strategyComposition[strategyId]
        );
    }

    /// @dev The AccessControl + ERC-165 introspection must resolve across both parents.
    /// @param interfaceId The ERC-165 interface identifier being queried.
    /// @return True if the interface is supported by any parent in the resolution chain.
    function supportsInterface(bytes4 interfaceId) public view override(AccessControlUpgradeable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
