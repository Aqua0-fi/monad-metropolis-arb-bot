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

/// @title Events
/// @author Aqua0 Team
/// @notice Canonical event surface for the Aqua0 vault architecture that the automated monitor, the
///         brain indexer, and the public docs build against.
/// @dev Library-scoped (call sites use `emit Events.X(...)`). Topic-0 is derived from the event signature
///      alone, not the library name, so this location is ABI-neutral.
///
///      SURFACE STABILITY CONTRACT: these signatures are FROZEN once integrators (monitor rules, the
///      indexer schema, the docs event reference) build against them. Do NOT change argument types,
///      names, or ordering without coordinating with backend (monitor and brain) plus docs.
///
///      Every event declared here has at least one emit site. Do not add a declaration ahead of the code
///      that emits it; a never-emitted event is a phantom the monitor and docs cannot rely on.
library Events {
    // ============================================================
    // Asset-vault surface
    // ============================================================

    // ----- Emergency stop (VaultFactory) -----

    /// @notice Factory-wide emergency stop tripped (all asset vaults paused atomically).
    event PausedAll(address indexed caller);

    // ----- Per-vault JIT metering backstop -----

    /// @notice A JIT pull would have exceeded the vault's per-window JIT meter and was blocked. Monitor
    ///         alarm for signer-drain-via-JIT and for JIT-starves-ships liveness pressure.
    event JitMeterBreach(address indexed vault, address indexed adapter, uint256 attempted, uint256 windowRemaining);

    // ============================================================
    // Asset-vault scaffold (emitted now by AssetVault / VaultFactory / VaultRegistry)
    // ============================================================

    /// @notice A new asset vault was deployed by the factory (one beacon proxy per asset per chain).
    event VaultCreated(address indexed asset, address indexed vault, string name, string symbol);

    /// @notice A vault was added to the registry's asset->vault allowlist (the set adapters trust).
    event VaultRegistered(address indexed asset, address indexed vault);

    /// @notice A vault was removed from the registry allowlist.
    event VaultDeregistered(address indexed asset, address indexed vault);

    /// @notice An adapter was added to or removed from the registry's trusted-adapter allowlist (the
    ///         set of venue adapters the composer and vaults will interact with).
    event AdapterAllowlisted(address indexed adapter, bool allowed);

    /// @notice The registry issued a monotonic consent-class id for a strategy key. The same id is used
    ///         across every per-asset vault the strategy spans.
    event StrategyClassRegistered(bytes32 indexed strategyKey, uint256 indexed classId);

    // ----- Composer -----

    /// @notice The Composer executed a backend-signed capital op against a vault. `action` is the op
    ///         discriminator (deploy / return / settle); `amount` is the moved principal (0 for settle)
    ///         and `pnl` the realized delta (0 for deploy/return). Consumed `nonce` for replay tracing.
    event ComposerExecuted(
        address indexed vault, address indexed adapter, uint8 action, uint256 amount, int256 pnl, uint256 nonce
    );

    /// @notice A venue router was added to or removed from the Composer's router allowlist.
    event ComposerDeployRouterAllowlisted(address indexed router, bool allowed);

    /// @notice The per-vault rolling JIT/deployment meter limit changed (0 = disabled).
    event ComposerJitLimitSet(address indexed vault, uint256 limit);

    /// @notice The Composer's backend signer key was rotated.
    event ComposerSignerSet(address indexed previous, address indexed current);

    /// @notice A stray token balance was swept out of the Composer. A vault-backed token can only ever be
    ///         swept home to its own vault; anything else goes to the admin's chosen recipient.
    event ComposerTokensRescued(address indexed token, address indexed to, uint256 amount);

    // ----- Venue adapters -----

    /// @notice A venue adapter shipped a strategy to 1inch Aqua using capital the Composer had already
    ///         deployed to it. `strategyId` is the stable id (keccak256 of the initial bytes).
    event AdapterStrategyShipped(
        address indexed adapter, bytes32 indexed strategyId, address[] tokens, uint256[] amounts
    );

    /// @notice A venue adapter docked (deactivated) a live strategy in Aqua. The docked capital stays in
    ///         the adapter until the Composer pulls it back into the vault.
    event AdapterStrategyDocked(address indexed adapter, bytes32 indexed strategyId, bytes32 aquaHash);

    /// @notice A venue adapter rotated a strategy's bytecode under the same stable `strategyId`.
    event AdapterStrategyReshipped(
        address indexed adapter, bytes32 indexed strategyId, bytes32 oldAquaHash, bytes32 newAquaHash, uint256[] amounts
    );

    /// @notice Admin last-resort teardown of a strategy's local state on a venue adapter (Aqua ledger
    ///         reconciled off-chain). `dockAttempted` is false when the on-chain `aqua.dock` was skipped
    ///         or reverted.
    event AdapterStrategyForceCleared(
        address indexed adapter, bytes32 indexed strategyId, bytes32 lastHash, bool dockAttempted
    );

    /// @notice A guardian docked a live strategy WITHOUT the strategist's signature (the lost-key escape
    ///         hatch). Distinct from a normal signed dock so an unsigned teardown is auditable.
    event AdapterStrategyEmergencyDocked(address indexed adapter, bytes32 indexed strategyId, bytes32 aquaHash);

    /// @notice A venue adapter's one-strategy-per-token risk control was toggled.
    event AdapterOneStrategyPerTokenSet(address indexed adapter, bool enabled);

    /// @notice What a strategy ACTUALLY returned, emitted on every dock and reship. `shipped` is the
    ///         principal committed at ship time; `venueReturned` is Aqua's own per-token ledger read
    ///         immediately before the dock zeroes it. They diverge as soon as a swap runs (Aqua pulls
    ///         tokenOut out of the maker and pushes tokenIn into it), so this pair is the settlement
    ///         source the backend reconciles each vault's realized PnL against. For a fee-on-transfer
    ///         token `venueReturned` is Aqua's credited amount, not the adapter's balance; size the
    ///         return leg off `freeBalance(token)`.
    event AdapterStrategyReconciled(
        address indexed adapter,
        bytes32 indexed strategyId,
        address[] tokens,
        uint256[] shipped,
        uint256[] venueReturned
    );

    /// @notice A venue adapter granted the Composer a bounded approval to pull `token` home to its
    ///         vault. The adapter's only egress for vault-backed capital, so it is high-signal.
    event AdapterComposerReturnApproved(address indexed adapter, address indexed token, uint256 amount);

    /// @notice Admin swept a token with no registry vault out of a venue adapter (dust, an airdrop, or
    ///         an asset whose vault was deregistered). Vault-backed tokens can never leave this way.
    event AdapterTokensRescued(address indexed adapter, address indexed token, address indexed to, uint256 amount);

    /// @notice A timelocked swap of an adapter's Composer was proposed. Accept is gated until `eta`.
    event AdapterComposerProposed(address indexed adapter, address indexed pending, uint256 eta);

    /// @notice A timelocked adapter Composer swap was accepted after its delay elapsed.
    event AdapterComposerSet(address indexed adapter, address indexed previous, address indexed current);

    /// @notice A pending adapter Composer swap was cancelled before acceptance.
    event AdapterComposerProposalCancelled(address indexed adapter, address indexed pending);

    // ----- Multi-class vault -----
    //
    // Under the shared pool the consent class IS the strategy, so these events' first id is the
    // `strategyId` (== the registry-issued class id). The event NAMES keep the historical `Class` prefix
    // (a frozen wire constant; topic-0 depends on the signature, not the name), but the id PARAM is
    // `strategyId`: a param named `classId` here would carry a strategyId, an ABI lie.

    /// @notice A strategy (consent class) was registered on a multi-class vault. The id is registry-issued.
    event ClassRegistered(address indexed vault, uint256 indexed strategyId);

    /// @notice The strategist authorized to sign strategies for a strategy was set or rotated.
    event ClassStrategistSet(address indexed vault, uint256 indexed strategyId, address indexed strategist);

    /// @notice A single strategy was paused (independent of the vault-wide pause), freezing only that
    ///         strategy's custody/harvest ops while the rest of the vaults keeps running.
    event ClassPaused(address indexed vault, uint256 indexed strategyId);

    /// @notice A single strategy was unpaused by admin after review.
    event ClassUnpaused(address indexed vault, uint256 indexed strategyId);

    /// @notice The composer sourced shared idle into a strategy and sent it to a venue. `amount` is the
    ///         principal booked as deployed; it is the exact amount the VENUE received. `deployCapital` measures
    ///         the landing and books what the venue actually got: on a fee-on-transfer / negative-rebase short
    ///         delivery it charges the shortfall to the sourcing committers (`StrategyDeployShortfall`) and emits
    ///         the DELIVERED amount here, so `deployed` can never exceed what the venue holds.
    event ClassCapitalDeployed(
        address indexed vault, uint256 indexed strategyId, address indexed venue, uint256 amount
    );

    /// @notice The composer returned a strategy's principal from a venue. `amount` is what the vault actually
    ///         received (FOT-measured); a surplus over the sourced principal is booked as a segregated fee.
    ///         The per-LP breakdown of the unwind is the `StrategyCapitalReturned` / `StrategyFeeAccrued`
    ///         events, emitted once per committer inside the same call.
    event ClassCapitalReturned(
        address indexed vault, uint256 indexed strategyId, address indexed venue, uint256 amount
    );

    /// @notice Admin/guardian released `amount` of `segregatedFees` that had been reserved without a
    ///         matching claimable `credit` (a pre-fix `returnCapital` surplus on a `deployed == 0` strategy),
    ///         restoring it to deployable idle. Reconciliation only, no tokens move.
    event SegregatedFeesReconciled(address indexed vault, uint256 amount);

    /// @notice Same-chain realized PnL for a strategy, settled by a venue adapter through the composer. A
    ///         gain books a fee to the strategy's committers; a loss marks the strategy's PnL pool down.
    event ClassAdapterSettled(
        address indexed vault, uint256 indexed strategyId, address indexed adapter, int256 realizedPnL
    );

    /// @notice The bounded cross-chain PnL reporter filled a strategy's in-flight delta for an epoch (gains
    ///         stream and vest, losses recognized immediately). `sharePriceRayAfter` is that strategy's drift
    ///         metric in RAY (1e27) - `pnlBase / deployed` - for monitoring, NOT an accounting value.
    event ClassPnLReported(
        address indexed vault,
        uint256 indexed strategyId,
        uint256 indexed epoch,
        int256 xChainDelta,
        uint256 sharePriceRayAfter
    );

    /// @notice A strategy's per-epoch rate clamp truncated a report. High-signal monitor alarm.
    event ClassClampHit(
        address indexed vault,
        uint256 indexed strategyId,
        uint256 indexed epoch,
        int256 requestedDelta,
        int256 clampedDelta
    );

    /// @notice On bridge/settlement landing, a strategy's reported delta did not match the settled amount;
    ///         over-reports beyond tolerance are clawed from the strategy's UNVESTED gain only (vested gains
    ///         are crystallized first). High-signal monitor alarm.
    event ClassReconciliationMismatch(
        address indexed vault,
        uint256 indexed strategyId,
        bytes32 indexed route,
        int256 reportedDelta,
        int256 settledDelta,
        int256 clawbackFromUnvested
    );

    /// @notice A bridge landing was reconciled against `strategyId`/`route`. Emitted on EVERY settlement (not
    ///         just a mismatch) so the indexer can assert that the route key matches the one `report` used,
    ///         and can watch `lossNetting`, the correction applied to the strategy's cross-chain PnL. A
    ///         positive `lossNetting` means a previously reported in-flight loss was reversed (the composer
    ///         asserting it did not materialize); the monitor alarms on that.
    event ClassBridgeSettled(
        address indexed vault,
        uint256 indexed strategyId,
        bytes32 indexed route,
        bytes32 settlementId,
        int256 settledDelta,
        int256 lossNetting
    );

    /// @notice The vault-level hybrid-PnL safety parameters changed (vault-uniform, applied to each
    ///         strategy's own totals). `maxBpsPerEpoch` is bounded by the immutable ceiling.
    event ClassPnLParamsSet(
        address indexed vault, uint64 epochLength, uint16 maxBpsPerEpoch, uint16 reconcileToleranceBps
    );

    /// @notice The bounded committer-set and per-LP commitment-set size caps were retuned (layout-safe).
    event SetBoundsUpdated(address indexed vault, uint256 maxCommittersPerStrategy, uint256 maxCommitmentsPerLp);

    /// @notice A strategy's async redeems were (re)bound to a settlement `route` (the per-route timeout key).
    event SettlementRouteSet(address indexed vault, uint256 indexed strategyId, bytes32 route);

    /// @notice Guardian stripped one strategy's unvested reporter gain and paused THAT strategy only, leaving
    ///         the rest of the vault running. `reason` is a short human/machine tag.
    event ClassGuardianVeto(address indexed vault, uint256 indexed strategyId, address indexed guardian, string reason);

    /// @notice An async redeem of a strategy's deployed principal was requested (the sync exit draws free
    ///         principal and does not emit this). `assets` is the FIXED escrowed asset amount the claim pays
    ///         (there is no share-price strike at claim). Never-trapped: `claimableAt = requestedAt +
    ///         timeout[route]`, bounded by the immutable global maximum, so it is claimable at `claimableAt`
    ///         even absent an attestation.
    event ClassSettlementRequested(
        address indexed vault,
        uint256 indexed strategyId,
        address indexed controller,
        uint256 requestId,
        uint256 assets,
        bytes32 route,
        uint64 requestedAt,
        uint64 claimableAt
    );

    /// @notice A previously-requested strategy async redeem was claimed. `composerStruck` is true when the
    ///         composer attested capital-is-free (fulfilled) before the timeout; false when the never-trapped
    ///         timeout backstop made it claimable. It is the request's `fulfilled` flag, NOT an attestation
    ///         signature.
    /// @dev `owner` is the account whose `principal` is debited; `controller` is only who may claim.
    ///      ERC-7540 allows them to differ, so an indexer that folds this event MUST key on `owner`.
    /// @dev `escrowReleased` is the FULL escrow the claim releases; `assets` is only what was paid.
    ///      They diverge exactly when a realized loss capped recovery below the escrow, and the vault
    ///      then does `asyncHeld -= escrowReleased` while `principal -= assets`. Without both numbers
    ///      an indexer must use one for both and its `asyncHeld` drifts high forever, understating
    ///      free principal. An event that moves two ledgers has to name both amounts.
    event ClassSettlementClaimed(
        address indexed vault,
        uint256 indexed strategyId,
        address indexed controller,
        uint256 requestId,
        uint256 assets,
        bool composerStruck,
        address owner,
        uint256 escrowReleased
    );

    // ----- Mid-swap net settlement (any trader-driven venue adapter) -----

    /// @notice A venue adapter settled a strategy's net delta during a swap. `netToStrategy` is signed:
    ///         negative when the vault sold its asset out to fund the swap (sourced from committers' free
    ///         principal), positive when it received. `venue` is the settling adapter. Value-PnL is
    ///         attributed off-chain.
    event ClassVenueSettled(
        address indexed vault, uint256 indexed strategyId, address indexed venue, int256 netToStrategy
    );

    /// @notice The per-vault mid-swap net-outflow meter limit changed (0 disables the meter). The meter is
    ///         one aggregate budget over every mid-swap venue seam, not per venue.
    event VenueOutflowLimitSet(address indexed vault, uint256 limit);

    /// @notice An LP reclassified swap-proceeds `composition` as its own `principal`, in place. No tokens
    ///         moved; the amount became backing (and so sellable room) in THIS vault.
    event CompositionConverted(address indexed vault, uint256 indexed strategyId, address indexed lp, uint256 assets);

    event VaultDeposit(address indexed vault, address indexed caller, address indexed receiver, uint256 assets);

    event VaultWithdraw(
        address indexed vault,
        address indexed caller,
        address indexed owner,
        address receiver,
        uint256 assets,
        uint256 fromPrincipal,
        uint256 fromCredit
    );

    event StrategyCommitmentSet(address indexed vault, address indexed lp, uint256 indexed strategyId, bool backing);

    /// @notice A committer's principal was sourced INTO a strategy (deploy or mid-swap sell), pro-rata by
    ///         room. `amount` is what this LP contributed to this source. Emitted once per drawn committer.
    event StrategyCapitalSourced(address indexed vault, uint256 indexed strategyId, address indexed lp, uint256 amount);

    /// @notice A committer's principal was returned OUT of a strategy on `returnCapital`, pro-rata by its
    ///         current participation. `amount` is the principal unwound for this LP. Emitted once per
    ///         committer inside the return loop - the per-LP mirror of `StrategyCapitalSourced`, so the
    ///         indexer reconstructs per-LP deployed state from events alone rather than replaying the
    ///         pro-rata unwind (whose committer iteration order is swap-and-pop, not inferable off-chain).
    event StrategyCapitalReturned(
        address indexed vault, uint256 indexed strategyId, address indexed lp, uint256 amount
    );

    /// @notice A committer bore its pro-rata share of a `deployCapital` egress shortfall (a fee-on-transfer /
    ///         negative-rebase asset delivered less to the venue than was sourced). `charged` is the realized
    ///         loss debited from this LP's `principal` and `deployedInto` for the strategy. Emitted once per
    ///         charged committer, so the indexer reconstructs the per-LP principal + deployed drop from events
    ///         (the loss is charged to the SOURCING committers of this deploy, not returned to idle).
    event StrategyDeployShortfall(
        address indexed vault, uint256 indexed strategyId, address indexed lp, uint256 charged
    );

    /// @notice A committer's principal was written down by its pro-rata share of a FINAL-CLOSE return shortfall:
    ///         `returnCapital(finalClose=true)` returned less than the strategy's `deployed` (a fee-on-transfer
    ///         return skim, or a realized trading loss), so the unrecoverable residual is charged as a realized
    ///         loss and the committer's `deployedInto` for the strategy is zeroed. `loss` is the principal debited
    ///         from this LP. Emitted once per charged committer, so the indexer reconstructs the per-LP write-down
    ///         and the full unwind (this is a LOSS, distinct from `StrategyCapitalReturned` which is recovered
    ///         principal returning to idle).
    event StrategyReturnLoss(address indexed vault, uint256 indexed strategyId, address indexed lp, uint256 loss);

    /// @notice `lp`'s principal was sold to source a mid-swap OUT leg. Emitted per selling committer.
    /// @dev Without this the debit is invisible: `PoolLib.sellForSwap` reduces `principal[lp]` and no
    ///      other event names the LP, so an indexer folding deposits and withdrawals alone reports a
    ///      balance higher than the vault's. Observed in production before this existed.
    event StrategyPrincipalSold(address indexed vault, uint256 indexed strategyId, address indexed lp, uint256 sold);

    /// @notice A committer's fee for a strategy was credited into its withdrawable `credit`. `credited` is the
    ///         amount added. Emitted on EVERY per-LP credit increase: the deployed-fee accumulator
    ///         crystallizing (source / return / `redeemStrategyPnL`) AND the mid-swap spread on a venue
    ///         credit, so the indexer sees every change to a committer's credit from events alone.
    event StrategyFeeAccrued(address indexed vault, uint256 indexed strategyId, address indexed lp, uint256 credited);

    event StrategyPnLClaimed(
        address indexed vault,
        uint256 indexed strategyId,
        address indexed owner,
        address receiver,
        uint256 shares,
        uint256 assets
    );

    // ----- Cross-chain LP fronting (source lock lifecycle + destination landing credit) -----
    //
    // `frontId` is the join key across chains: the source `FrontLocked`/`FrontCommitted`/`FrontReleased`
    // events on chain A share it with the destination `FrontLandingCredited` on chain B, so the monitor can
    // assert the front-before-commit ordering and the 1:1 obligation-to-landing discipline off a single id.

    /// @notice LP-A escrowed `amount` of asset PRINCIPAL from its `strategyId` position for cross-chain front
    ///         `frontId`. State -> Locked. The escrow substrate is the LP's principal CLAIM (held out of its
    ///         free principal), not a transferable share; no front exists yet.
    event FrontLocked(
        address indexed vault, uint256 indexed strategyId, bytes32 indexed frontId, address owner, uint256 amount
    );

    /// @notice A front lock was hardened Locked -> Committed by the signed Composer spine. From here LP-A's
    ///         self-cancel is disabled; a chain-B front may only be authorized after this fires.
    event FrontCommitted(address indexed vault, uint256 indexed strategyId, bytes32 indexed frontId);

    /// @notice A committed front was struck and released toward the bridge (Committed -> Released, terminal).
    ///         `assets` is the struck asset amount that left the shared idle toward the bridge.
    event FrontReleased(address indexed vault, uint256 indexed strategyId, bytes32 indexed frontId, uint256 assets);

    /// @notice A still-`Locked` front was cancelled (Locked -> Cancelled, terminal) and its escrowed
    ///         `amountReturned` of principal was released back to LP-A. Only reachable before any front exists.
    event FrontCancelled(
        address indexed vault, uint256 indexed strategyId, bytes32 indexed frontId, uint256 amountReturned
    );

    /// @notice An admin/guardian aborted a `Committed` front (Committed -> Cancelled, terminal), releasing
    ///         both the hard reservation and the owner's principal hold. The last-resort escape hatch for a
    ///         front whose bridge/operator flow is stuck.
    event FrontAborted(
        address indexed vault, uint256 indexed strategyId, bytes32 indexed frontId, uint256 amountReturned
    );

    /// @notice A bridge landing for front `frontId` was credited to the shared idle by the MEASURED amount
    ///         that physically arrived. One-shot per `(strategyId, frontId, settlementId)`; the brain
    ///         attributes LP-B's make-whole + fee and LP-A's new chain-B position from this event.
    /// @notice One filler's leg of a cross-chain front was recorded on the destination vault. `frontId` is the
    ///         cross-chain join key, so this pairs with the source chain's `FrontLocked`/`FrontReleased`.
    ///         Emitted per filler: one front fans out across N, and the monitor needs each leg's pledge and fee
    ///         to reconcile the settlement rather than only the aggregate.
    event FrontObligationOpened(
        address indexed vault,
        uint256 indexed strategyId,
        bytes32 indexed frontId,
        address filler,
        address beneficiary,
        uint256 pledged,
        uint256 feeOwed
    );

    /// @notice One filler's leg was settled out of the measured landing. Both amounts are what was ACTUALLY
    ///         paid, never the nominal claim: a landing short of the aggregate claim pays each leg its clamped
    ///         pro-rata share, so a reconciler reading these events sees the filler's real position without
    ///         needing the backend's reservation numbers. Pair with `FrontLandingUnderpaid` on the same
    ///         `frontId` to see the gap.
    event FrontObligationSettled(
        address indexed vault,
        uint256 indexed strategyId,
        bytes32 indexed frontId,
        address filler,
        uint256 restored,
        uint256 feeOwed
    );

    /// @notice One filler's leg was resolved WITHOUT a bridge landing, because the landing will not arrive.
    ///         `restored` and `feePaid` come only out of tokens the unwind physically pulled in, so they are
    ///         zero for an unfunded unwind; `unrecovered` is what the redirect took and did not give back, and
    ///         is the filler's realized loss. The leg is terminal from here.
    event FrontObligationAborted(
        address indexed vault,
        uint256 indexed strategyId,
        bytes32 indexed frontId,
        address filler,
        uint256 restored,
        uint256 feePaid,
        uint256 unrecovered
    );

    /// @notice A front resolved out of less than its legs claim: `received` did not cover
    ///         `Σredirected + ΣfeeOwed`. Every payout is clamped to what arrived rather than refused, because
    ///         the redirect took the fillers' principal one transaction earlier and a refusal cannot give it
    ///         back - it only makes the position permanent. Restoring principal ranks ahead of the fee.
    event FrontLandingUnderpaid(
        address indexed vault, uint256 indexed strategyId, bytes32 indexed frontId, uint256 required, uint256 received
    );

    event FrontLandingCredited(
        address indexed vault,
        uint256 indexed strategyId,
        bytes32 indexed frontId,
        bytes32 settlementId,
        uint256 credited
    );

    /// @notice The Composer was pointed at a participation registry (or zero, disabling fronting).
    event FillerRegistrySet(address indexed composer, address indexed registry);

    /// @notice The landing for front `frontId` arrived SHORT of the amount originally struck on the source
    ///         chain (a bridge fee, a fee-on-transfer vault asset, or an inaccurate off-chain relay). The gap
    ///         is written down as a realized loss against the strategy's `pnlPool` (mirrors the down-mark
    ///         `onAdapterSettle`/`onBridgeSettle` already apply for a tokenless negative valuation event) so
    ///         it shows up in the strategy's valuation instead of silently vanishing. The full LP-B make-whole
    ///         (crediting the specific
    ///         fronting LP for the shortfall) is a separate, later-scoped feature; this is the safety
    ///         write-down only.
    event FrontLandingShortfall(
        address indexed vault,
        uint256 indexed strategyId,
        bytes32 indexed frontId,
        bytes32 settlementId,
        uint256 shortfall
    );

    /// @notice The per-vault rolling fronting-release meter limit changed (0 disables fronting: no lock may
    ///         be created and no release may fire until a non-zero limit is armed).
    event FrontingReleaseLimitSet(address indexed vault, uint256 limit);

    // ----- V4 asset-vault adapter (hook) -----

    /// @notice The V4 asset-vault adapter settled a JIT swap: raw net currency deltas for the strategy, the backend
    ///         attribution feed (value-PnL is computed off-chain from `delta0`/`delta1`).
    event V4SwapSettled(
        address indexed adapter,
        uint256 indexed strategyId,
        bytes32 indexed swapId,
        address token0,
        int256 delta0,
        address token1,
        int256 delta1
    );

    /// @notice A JIT position configuration was set / removed / paused on the V4 asset-vault adapter.
    event V4JITPositionSet(bytes32 indexed poolId, int24 tickLower, int24 tickUpper, address token0, address token1);
    event V4JITPositionRemoved(bytes32 indexed poolId);
    event V4JITPositionPaused(bytes32 indexed poolId, bool active);

    /// @notice The class strategist approved / revoked `classId` settling against `poolId`
    ///         (the strategist-consent gate).
    event V4ClassApprovedForPool(bytes32 indexed poolId, uint256 indexed classId, address indexed strategist);
    event V4ClassRevokedForPool(bytes32 indexed poolId, uint256 indexed classId, address indexed strategist);

    /// @notice The V4 asset-vault adapter's backend signer was rotated, or its router allowlist toggled/updated.
    event V4SignerSet(address indexed adapter, address indexed previous, address indexed current);
    event V4JitTriggerAllowlistEnabled(address indexed adapter, bool enabled);
    event V4JitTriggerRouterAllowed(address indexed adapter, address indexed router, bool allowed);

    /// @notice Admin swept a token with no registry vault out of the V4 asset-vault adapter (dust / airdrop).
    ///         Vault-backed tokens can never leave this way; they only move through the settle seam.
    event V4TokensRescued(address indexed adapter, address indexed token, address indexed to, uint256 amount);

    /// @notice The V4 adapter's protocol-fee seam was configured (rate and recipient together). A zero
    ///         `recipient` with a zero `feePpb` is the INERT default a fresh deployment starts in: no fee is
    ///         charged and the swap path behaves exactly as it did before the seam existed.
    /// @param adapter   The adapter whose fee configuration changed.
    /// @param recipient The Aqua0-controlled account the fee accrues to; zero disarms the seam.
    /// @param feePpb    The rate in PARTS PER BILLION (1e9 == 100%), charged on the swapper's specified amount.
    event V4ProtocolFeeSet(address indexed adapter, address indexed recipient, uint32 feePpb);

    /// @notice One pool's protocol-fee rate OVERRIDE was set, replacing the global rate for that pool.
    /// @dev A `feePpb` of zero here is a DELIBERATE WAIVER - that pool is charged nothing - and is a
    ///      different state from having no override at all, which is `V4PoolProtocolFeeCleared`. The two
    ///      events are kept distinct so the effective rate of every pool stays reconstructible from logs
    ///      alone; a single event could not tell a waiver apart from a reset.
    /// @param adapter The adapter whose per-pool configuration changed.
    /// @param poolId  The pool the override applies to.
    /// @param feePpb  The pool's rate in PARTS PER BILLION (1e9 == 100%); zero means this pool is free.
    event V4PoolProtocolFeeSet(address indexed adapter, bytes32 indexed poolId, uint32 feePpb);

    /// @notice One pool's protocol-fee override was removed, so it falls back to the global rate again.
    /// @param adapter The adapter whose per-pool configuration changed.
    /// @param poolId  The pool whose override was dropped.
    event V4PoolProtocolFeeCleared(address indexed adapter, bytes32 indexed poolId);

    /// @notice A protocol fee was taken out of a JIT swap and paid to the recipient. Emitted only when a fee
    ///         actually moved, so summing this event reconstructs protocol revenue exactly.
    /// @param adapter  The adapter that took the fee.
    /// @param currency The currency the fee was taken in (the swap's SPECIFIED currency).
    /// @param to       The recipient credited.
    /// @param amount   The fee amount, in `currency` units.
    event V4ProtocolFeeTaken(address indexed adapter, address indexed currency, address indexed to, uint256 amount);

    /// @notice Emitted whenever an LP's on-chain filler-participation state changes (`FillerRegistry`).
    /// @param lp     The LP whose state changed.
    /// @param active The new participation state.
    /// @param nonce  The nonce value after the update (monotonically increasing).
    event FillerParticipationSet(address indexed lp, bool active, uint256 nonce);
}
