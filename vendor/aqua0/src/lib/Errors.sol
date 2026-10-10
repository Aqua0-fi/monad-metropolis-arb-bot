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

/// @title Errors
/// @author Aqua0 Team
/// @notice Custom errors used across the Aqua0 contract suite.
/// @dev Library of error declarations. Custom errors are gas-efficient and fully typed for off-chain
///      decoding; every `require(cond, ...)` in the suite uses one.
library Errors {
    // ----- Generic input validation -----

    /// @notice Thrown when an address parameter is the zero address.
    error ZeroAddress();

    /// @notice Thrown when an amount parameter is zero.
    error ZeroAmount();

    /// @notice Thrown when two arrays that must be the same length are not.
    error LengthMismatch();

    /// @notice Thrown when a signed payload's deadline has passed. Carries the payload `deadline` and the
    ///         block `timestamp` that exceeded it.
    error ExpiredDeadline(uint256 deadline, uint256 timestamp);

    /// @notice Thrown when a nonce has already been consumed. Carries the offending `nonce`.
    error NonceUsed(uint256 nonce);

    /// @notice Thrown when ECDSA recovery does not return the configured signer.
    error InvalidSignature();

    /// @notice Thrown when an EIP-712 domain version parameter is the empty string. An empty version is a
    ///         domain a deploy did not choose, so it is refused rather than signed against.
    error EmptyDomainVersion();

    // ----- V4Adapter -----
    // (The non-PoolManager caller guard is now `BaseHook.NotPoolManager`, inherited from OZ uniswap-hooks.)

    /// @notice Thrown when a JIT position has tickLower >= tickUpper. Carries the offending `tickLower`/`tickUpper`.
    error InvalidTickRange(int24 tickLower, int24 tickUpper);

    /// @notice Thrown when setJITPosition is called for an already-tracked poolId.
    error JitPositionAlreadyExists();

    /// @notice Thrown when removeJITPosition or pauseJITPosition is called for an unknown poolId.
    error JitPositionUnknown();

    /// @notice Thrown when removeJITPosition is called by an account that is neither the pool's JIT registrant
    ///         (the account whose permissionless setJITPosition armed it) nor an admin. Carries the caller.
    error NotJitRegistrant(address caller);

    /// @notice Thrown when a JIT swap is attributed to a classId its strategist has not approved for this
    ///         pool. The class-consent gate `_verifyAndRecordSwap` enforces before settling.
    error ClassNotApprovedForPool(bytes32 poolId, uint256 classId);

    /// @notice Thrown when beforeSwap is invoked for a poolId that has been paused via pauseJITPosition.
    error JitPositionPaused();

    /// @notice Thrown when a single beforeSwap injection exceeds `MAX_JIT_RANGES`. Bounds the
    ///         per-swap PoolManager.modifyLiquidity gas envelope. Carries the `provided` count and the `max`.
    error TooManyRanges(uint256 provided, uint256 max);

    /// @notice Thrown when transient-stored liquidity loaded in `afterSwap` does not fit in
    ///         a `uint128` (the original type at write time). Defensive boundary assertion. Carries `liquidity`.
    error LiquidityOverflow(uint256 liquidity);

    /// @notice Thrown when `_settleVirtualLiquidityDeltas` attempts to emit `SwapSettled`
    ///         with a zero `activeSwapId`; would only happen if hook callbacks fired
    ///         out of expected order. Defensive boundary assertion.
    error ActiveSwapIdMissing();

    /// @notice Thrown when the executed swap parameters (direction, size, price limit) do not
    ///         match the backend-signed JIT authorization. A signed JIT payload may be consumed
    ///         only by the exact swap it authorized; preventing a payload lifted from the public
    ///         mempool from being replayed against a different, LP-adverse swap (front-run,
    ///         direction-flip, or oversize drain).
    error JitSwapMismatch();

    /// @notice Thrown when `beforeSwap`'s `sender` (the address that called `PoolManager.swap`) does not
    ///         match the `executor` bound into the signed JIT payload. Closes the front-run vector where an
    ///         observer lifts a valid signed payload from the mempool and replays the identical swap through
    ///         a different router ahead of the intended trader, burning the one-shot nonce so the intended
    ///         trader's transaction reverts. Carries the actual `sender` and the payload's signed `executor`.
    ///         Binds the ROUTER only; `sender` is never the router's own caller, so a second caller of the
    ///         same router is not distinguished here.
    error JitExecutorMismatch(address sender, address executor);

    /// @notice Thrown when the JIT router allowlist is enabled and `beforeSwap`'s `sender`
    ///         (the address that called `PoolManager.swap`) is not allowlisted. Defense-in-depth
    ///         that narrows WHICH routers may consume signed JIT liquidity. It does not narrow which
    ///         caller of an allowlisted router may: an identical swap resubmitted through the same
    ///         allowlisted router by a second caller still passes.
    error RouterNotAllowed();

    /// @notice Thrown when a JIT swap leaves both pool currencies with a NON-ZERO net hook delta of the SAME
    ///         sign. The two-sided settle reads one leg as owed and the other as owing and casts each to
    ///         `uint256`, so a same-sign pair would wrap one of them into a ~1.16e77 amount and be settled
    ///         against a vault. Carries both signed deltas.
    error JitDeltaSignMismatch(int256 delta0, int256 delta1);

    // ----- SwapVMAdapter -----

    /// @notice Thrown when shipStrategy is invoked from a contract caller. The operator
    ///         must be an EOA to prevent same-transaction batch-ship drain attacks.
    error OperatorMustBeEOA();

    /// @notice Thrown when shipStrategy exceeds MAX_SHIPS_PER_BLOCK in a single block. Carries the `attempted`
    ///         count this block and the `cap`.
    error ShipsPerBlockCapExceeded(uint256 attempted, uint256 cap);

    /// @notice Thrown when shipStrategy is called with empty strategyBytes.
    error EmptyStrategy();

    /// @notice Thrown when shipStrategy is called for a strategyId that already has tokens recorded.
    error StrategyAlreadyShipped(bytes32 strategyId);

    /// @notice Thrown when dock/reship is called for a strategyId that was never shipped.
    error StrategyUnknown(bytes32 strategyId);

    /// @notice Thrown when dock/reship is called for a strategyId whose `_currentAquaHash` is zero.
    error StrategyNotActive(bytes32 strategyId);

    /// @notice Thrown when 1inch Aqua returns a hash that does not match `keccak256(strategyBytes)`.
    error AquaHashMismatch(bytes32 expected, bytes32 returned);

    /// @notice Thrown when a maker hook's `orderHash` does not match the two-hook settle buffer's pending
    ///         order (the buffer is keyed to guard against a router that interleaves hooks across swaps).
    error SwapOrderMismatch(bytes32 expected, bytes32 actual);

    /// @notice Thrown when reshipStrategy is called with bytes whose hash equals the current Aqua hash.
    error ReshipBytesIdentical();

    /// @notice Thrown when shipStrategy/reshipStrategy is called with the same token address twice
    ///         in the tokens array. Duplicates corrupt _strategyAmounts/_committedBalance accounting.
    error DuplicateToken(address token);

    /// @notice Thrown when `shipStrategy` is called for a token that already backs a live strategy.
    ///         Risk control: parallel same-token strategies share one pooled Aqua allowance +
    ///         inventory, so docking/reshipping one corrupts the others' accounting once Aqua.pull
    ///         runs (PoC + fuzz proven). Enforce one live strategy per token until the per-strategy
    ///         remaining-inventory accounting rework lands.
    error TokenAlreadyHasLiveStrategy(address token);

    // ----- Asset-vault SwapVM adapter (egress) -----

    /// @notice Thrown when the operator asks the adapter to approve the Composer for a token that has
    ///         no vault in the registry. The Composer's return leg resolves the token it pulls from the
    ///         target vault's `asset()`, so an unvaulted token can never be pulled by it; such residue
    ///         leaves through the admin rescue instead.
    error TokenHasNoVault(address token);

    /// @notice Thrown when an admin rescue would move a vault-backed token anywhere other than its own
    ///         vault. Vault capital may only travel adapter -> Composer -> vault, so no admin key can ever
    ///         divert it. The adapter's rescue refuses such a token outright; the Composer's sweeps it home.
    error TokenHasVault(address token, address vault);

    /// @notice Thrown when an egress approval exceeds the adapter's free balance of the token (its
    ///         balance minus the amount committed to live strategies). Bounds the Composer's pull to
    ///         capital that no live Aqua strategy is relying on.
    error InsufficientFreeBalance(address token, uint256 requested, uint256 free);

    // ----- FillerRegistry -----

    /// @notice Thrown when meta-tx nonce does not match the expected next nonce for the LP. Carries the
    ///         `provided` nonce and the `expected` next nonce.
    error MetaTxNonceMismatch(uint256 provided, uint256 expected);

    /// @notice Thrown when meta-tx ECDSA recovery does not match the LP address.
    error MetaTxSignatureInvalid();

    // ----- Vault architecture -----

    /// @notice The registry already holds a vault for this asset (one vault per asset per chain).
    error AssetAlreadyHasVault(address asset, address existing);

    /// @notice The address is not a vault registered in this registry.
    error VaultNotRegistered(address vault);

    /// @notice The address does not implement `IVenueAdapter` (marker call reverted or returned false).
    error NotAqua0Adapter(address adapter);

    /// @notice The adapter is bound to a different registry, so this registry may not allowlist it.
    error AdapterRegistryMismatch(address adapter, address boundRegistry);

    /// @notice An async redeem request is not yet claimable: capital has not been attested free and the
    ///         per-route settlement timeout has not elapsed.
    error RedeemRequestNotClaimable(uint256 requestId, uint64 claimableAt);

    /// @notice An async redeem request has already been claimed.
    error RedeemRequestClaimed(uint256 requestId);

    /// @notice The caller is not the controller authorized to manage/claim this redeem request.
    error NotRequestController(address caller, address controller);

    // NOTE: a claim whose backing capital has not yet returned reverts on `InsufficientSharedIdle` (the pool
    // does not physically hold it) or `ExceedsWithdrawable` (the owner's own deployed principal has not
    // returned). The RIGHT to claim is still never trapped - it vests at the timeout; only the payout waits.

    /// @notice A per-route settlement timeout exceeded the immutable global maximum (never-trapped
    ///         ceiling) or was zero.
    error InvalidRouteTimeout(uint64 timeout, uint64 globalMax);

    // ----- Vault hybrid PnL harvest -----

    /// @notice A cross-chain PnL report did not advance past the last reported epoch. Reports are
    ///         monotonic per epoch so a compromised reporter cannot re-report an old epoch to stack
    ///         multiple clamped gains inside one window.
    error PnLEpochNotAdvanced(uint64 epoch, uint64 lastReported);

    /// @notice A new upward-clamp report was attempted before the current clamp window elapsed. The epoch
    ///         counter is monotonic but caller-supplied, so it does not bound wall-clock time; this gate
    ///         binds the per-epoch gain clamp to real time so N same-block reports cannot stack N clamps.
    error PnLEpochNotElapsed(uint64 readyAt, uint64 nowTs);

    /// @notice A report tried to advance the class's monotonic epoch counter by more than
    ///         `MAX_EPOCH_ADVANCE`. Unbounded, a single compromised reporter could ratchet the counter to
    ///         `type(uint64).max` and permanently brick `report()` for that class.
    error PnLEpochJumpTooLarge(uint64 epoch, uint64 maxAllowed);

    /// @notice `report()` was called on a class whose reporter a guardian froze via `guardianVeto`. The
    ///         admin clears the freeze with `unpauseClass` after review; honest same-chain down-marks stay
    ///         reachable meanwhile through the COMPOSER-gated `onAdapterSettle` loss path.
    error ReporterFrozen(uint256 classId);

    /// @notice The same bridge settlement was submitted twice for a `(class, route)`. Idempotency is keyed on
    ///         the settlement's own identity, so a re-signed duplicate (fresh composer nonce, same landing)
    ///         can never re-debit the class, and a later `report` can never re-open a consumed settlement.
    error SettlementAlreadyConsumed(uint256 classId, bytes32 route, bytes32 settlementId);

    /// @notice A bridge settlement carried the zero settlement id, which is reserved as "unset". Requiring a
    ///         real id is what stops a default-zeroed op from silently reconciling a route.
    error ZeroSettlementId();

    /// @notice The owner tried to set an epoch length outside `[MIN_EPOCH_LENGTH, MAX_EPOCH_LENGTH]`. Below
    ///         the floor the wall-clock clamp window collapses and the reporter's per-epoch gain rate is
    ///         effectively unbounded; above the ceiling a legitimate gain would never finish vesting and the
    ///         clamp window would never reopen.
    error InvalidEpochLength(uint64 requested, uint64 min, uint64 max);

    /// @notice The owner tried to set the per-epoch share-price clamp above the immutable ceiling. No
    ///         admin key may widen the clamp enough to let the bounded reporter jump share price.
    error MaxBpsAboveCeiling(uint16 requested, uint16 ceiling);

    /// @notice The owner set a reconciliation tolerance above 100% (10_000 bps), which would disable
    ///         over-report clawback entirely.
    error InvalidReconcileTolerance(uint16 bps);

    // ----- Cross-chain LP fronting (source lock + destination landing credit) -----

    /// @notice `requestFrontLock` names a `frontId` that already has a live or terminal lock. A frontId is
    ///         a one-shot key: once it leaves `None` it can never be re-locked, so a re-used id (a
    ///         double-lock or a replayed request) is refused rather than silently overwriting a lock.
    error FrontIdExists(bytes32 frontId);

    // NOTE: a commit / release / cancel naming a `frontId` with no live lock (or a different strategy than the
    // one it was locked under) reverts on `FrontWrongState`, which carries the expected + actual state.

    /// @notice A front-lock transition was attempted from the wrong state (e.g. releasing a lock that is not
    ///         `Committed`, or cancelling one that is not `Locked`). `expected`/`actual` are `FrontState`
    ///         members. This is the terminal-state guard that makes double-release and release-then-cancel
    ///         impossible: the state moved, so a re-signed duplicate op cannot re-drive the transition.
    error FrontWrongState(bytes32 frontId, uint8 expected, uint8 actual);

    /// @notice `cancelFrontLock` was called by the LP (or its operator) before the lock's `cancellableAt`
    ///         self-cancel window opened. Admin may cancel a `Locked` front at any time; the LP's
    ///         never-trapped self-cancel only vests after this stamp.
    error FrontNotCancellable(bytes32 frontId, uint64 cancellableAt);

    /// @notice A cross-chain release would push the vault's rolling per-window fronting-release meter past
    ///         its limit. Bounds a compromised composer signer to one window's worth of cross-chain drain,
    ///         independent of the JIT / venue-outflow meters. A zero `windowRemaining` also means fronting
    ///         releases are halted (limit set to 0).
    error FrontingReleaseMeterExceeded(uint256 attempted, uint256 windowRemaining);

    // ----- Cross-chain fronting: destination-side obligations -----
    //
    // These name their OWN cause deliberately. Reusing a nearby front error would have been cheaper and would
    // have pointed an operator at the wrong thing: an exclusivity refusal is not a duplicate id, a
    // self-obligation is not an authorization failure, and a short landing is not a strategy backing-cap
    // breach. An error that names the wrong cause is the defect this codebase keeps finding.

    /// @notice `filler` already has an open front on `strategyId`. Concurrent fronts per (filler, strategy) are
    ///         refused rather than queued: a second open would overwrite the first, orphaning an obligation and
    ///         routing one beneficiary's value to another. Carries the front already held so an operator can
    ///         see WHICH front is blocking rather than only that one is.
    error FillerFrontExclusive(address filler, uint256 strategyId, bytes32 openFrontId);

    /// @notice A filler cannot stand in for themselves: the redirect would be a no-op that still consumed the
    ///         exclusivity slot for that (filler, strategy).
    error FrontSelfObligation(address account, uint256 strategyId);

    /// @notice A declared maker-fee rate exceeds the router's own maximum. `feePpb` is PARTS PER BILLION,
    ///         1e9 == 100% - so a value that looks like basis points is either far too small to matter or, past
    ///         the ceiling, refused here.
    error FeeRateOutOfRange(uint32 feePpb, uint32 maxFeePpb);

    /// @notice A FRONT_OPEN carried no allocations: an obligation set naming nobody, which settlement could
    ///         not honour and no reviewer would see.
    error EmptyAllocationSet(bytes32 frontId);

    /// @notice The allocation set is not sorted ascending by filler, or contains a duplicate. Sorting makes the
    ///         root independent of the matcher's fill order; a duplicate is refused rather than summed, because
    ///         it means the matcher produced something it should not have and summing would hide it.
    error AllocationsNotSorted(bytes32 frontId, address filler);

    /// @notice The allocation set does not hash to the signed commitment. The set written on-chain must be
    ///         provably the set the signer committed to, not merely one the caller asserts.
    error AllocationsRootMismatch(bytes32 frontId, bytes32 expectedRoot);

    /// @notice The declared front size does not equal the sum of the committed allocations, so the op claims a
    ///         front larger than the obligations backing it.
    error AllocationsTotalMismatch(bytes32 frontId, uint256 allocated, uint256 declared);

    /// @notice An op carried a non-zero value in a field its action does not use. Enforced once, before the
    ///         action switch, so a future action inherits the refusal rather than silently permitting a stray
    ///         value - the property that keeps the field discipline mechanical rather than conventional.
    error UnusedFieldNonZero(uint8 action);

    /// @notice The Composer has no participation registry configured, so filler consent cannot be verified.
    ///         Fronting refuses rather than proceeding unverified: an unverifiable consent is not consent.
    error FillerRegistryUnset();

    /// @notice `filler` has not opted in to fronting. Read literally: an absent registry row is NOT consent.
    error FillerNotOptedIn(address filler);

    /// @notice The measured bridge landing does not cover what settlement must pay out (restored principal plus
    ///         fees owed). Distinct from `BackingCapExceeded`, which is about a strategy's priced proceeds
    ///         against a swap receipt - a different quantity with a different remedy.
    error FrontLandingInsufficient(bytes32 frontId, uint256 required, uint256 received);

    /// @notice `requestFrontLock` was called while fronting is disabled on this vault. Fronting is off until
    ///         the admin arms a non-zero `frontingReleaseLimit`, so a lock can never be created with no
    ///         metered release path to leave through (which would strand it once committed).
    error FrontingDisabled();

    /// @notice `cancelFrontLock` was called by an account that is neither the lock's `owner` nor a vault
    ///         admin. There is no delegation: the LP alone, or the admin as an escape hatch, may recover an
    ///         escrowed, still-`Locked` front.
    error FrontUnauthorized(bytes32 frontId, address caller);

    // ----- Composer -----

    /// @notice A composer op carried a signature that did not recover to the configured composer
    ///         signer. The backend signature is the authorization; every op is gated by it.
    error NotComposerSigner(address recovered, address expected);

    /// @notice A composer op reused a signer nonce. Nonces are single-use so a captured payload
    ///         cannot be replayed to move capital twice.
    error ComposerNonceUsed(uint256 nonce);

    /// @notice A composer op's deadline has passed. A stale signed payload is not executable.
    error ComposerPayloadExpired(uint256 deadline, uint256 nowTs);

    /// @notice The target adapter is not on the registry's trusted-adapter allowlist, so the Composer
    ///         refuses to route capital to it.
    error AdapterNotAllowed(address adapter);

    /// @notice The op named a venue router that is not on the Composer's router allowlist.
    error ComposerRouterNotAllowed(address router);

    /// @notice A RETURN op carried a `pnl` other than 0 or 1. On a RETURN, `pnl` is a boolean final-close sentinel,
    ///         not a PnL value; enforcing {0,1} on-chain stops a raw PnL number from silently realizing a loss.
    error InvalidReturnSentinel(int256 pnl);

    /// @notice A FRONT_SETTLE op carried a negative `pnl`. On FRONT_SETTLE, `pnl` is repurposed as the
    ///         originally-struck source-chain locked amount, never a signed valuation delta.
    error InvalidLockedAmount(int256 pnl);

    /// @notice A capital deployment would breach the vault's rolling JIT meter (per-vault backstop
    ///         against a compromised composer-signer draining via repeated pulls).
    error JitMeterExceeded(address vault, uint256 attempted, uint256 windowRemaining);
    error JitLimitUnset(address vault);

    /// @notice The op carried an unrecognized action discriminator.
    error UnknownComposerAction(uint8 action);

    // ----- Multi-class vault -----

    /// @notice Thrown when registering a class id that already exists on the vault.
    error ClassAlreadyRegistered(uint256 classId);

    /// @notice Thrown when an op targets a class id the vault has never registered.
    error ClassNotRegistered(uint256 classId);

    /// @notice Thrown when an op targets a class that is individually paused (independent of the
    ///         vault-wide pause).
    error ClassIsPaused(uint256 classId);

    // NOTE: no shares are minted on deposit under the shared pool (the per-strategy position is a read-only
    // view over committed backing), so there is no zero-shares-minted condition to signal.

    // NOTE: there is no per-class idle balance and no deposit cap under the shared pool: deposits are
    // permissionless (any access gating is UI-only). An op that over-draws the single shared idle reverts on
    // `InsufficientSharedIdle`.

    /// @notice Thrown when registering a strategy key that already has an issued class id.
    error StrategyClassAlreadyRegistered(bytes32 strategyKey, uint256 classId);

    /// @notice Thrown when a mid-swap outflow would push the vault's rolling net-outflow meter past its
    ///         limit (per-vault backstop bounding the mid-swap drain surface across all classes). A zero
    ///         `windowRemaining` also means the venue is halted (limit set to 0).
    error VenueOutflowMeterExceeded(uint256 attempted, uint256 windowRemaining);

    /// @notice Thrown when a vault is initialized with a zero outflow limit. The meter is the sole
    ///         solvency-rate boundary under JIT, so a vault must never begin life unmetered. Zero means
    ///         "no outflow permitted", never "unlimited".
    error OutflowLimitUnset();

    // ----- Shared-pool capital model -----

    error InsufficientSharedIdle(uint256 requested, uint256 available);
    error ExceedsSegregatedFees(uint256 requested, uint256 available);
    /// @notice Thrown when a deploy names the vault itself as the venue. The egress transfer would then land back
    ///         in the vault, the receipt meter would read the full amount as a shortfall, and the sourcing
    ///         committers' principal would be written down as a realized loss though no capital left custody.
    error VenueIsSelf();
    error NotAdminOrGuardian(address caller);
    error BackingCapExceeded(uint256 strategyId, uint256 wouldBe, uint256 committedBacking);
    error RanOutOfBacking(uint256 strategyId, uint256 shortfall);
    error CannotUncommitLiveCapital(uint256 strategyId, address lp, uint256 deployed);
    error CannotUncommitLiveComposition(uint256 strategyId, address lp, uint256 composition);
    /// @notice Thrown when an LP named as the beneficiary of an unsettled cross-chain front tries to leave the
    ///         strategy's committer set. The landing credits their composition, and conservation is folded over
    ///         the CURRENT committer set, so leaving before the landing strands that composition outside the
    ///         fold and reverts every later capital op on the strategy.
    error CannotUncommitPendingFront(uint256 strategyId, address lp, uint256 pendingFronts);
    error ExceedsWithdrawable(address owner, uint256 requested, uint256 withdrawable);
    error CommitterSetFull(uint256 strategyId, uint256 max);
    error TooManyCommitments(address lp, uint256 max);
    error PrincipalUnauthorized(address caller, address owner);
    /// @notice Thrown when an LP with no principal tries to back a strategy. A commitment adds the caller to a
    ///         bounded committer set, so entry is priced at real principal held AT COMMIT TIME. That is an
    ///         entry check only: nothing re-tests it and nothing evicts a committer whose principal later
    ///         falls to zero, so holding a slot costs nothing to sustain.
    error NoPrincipalToCommit(address lp);

    // ----- Adapter composer timelock -----

    /// @notice Thrown when accepting a composer swap before its timelock has elapsed.
    error ComposerProposalNotReady(uint256 eta, uint256 nowTs);

    /// @notice Thrown when accepting or cancelling with no composer swap pending.
    error NoPendingComposerProposal();

    // ----- Aqua venue adapter (maker hooks) -----

    /// @notice Thrown when the adapter is constructed against a router whose immutable `AQUA()` is not the
    ///         Aqua the adapter ships into. That pairing makes every swap revert in `Aqua.safeBalances`, and
    ///         both bindings are immutable, so it is unfixable post-deploy.
    error RouterAquaMismatch(address routerAqua, address adapterAqua);

    /// @notice Thrown when the router's EIP-712 name is not "AquaSwapVMRouter"; i.e. it is a look-alike, not
    ///         the canonical Aqua router.
    error RouterNotAquaRouter(string routerName);

    /// @notice Thrown when a maker hook is entered by anyone other than the bound router. The hooks are
    ///         public entry points that move vault capital; without this check anyone drains a vault.
    error HookCallerNotRouter(address caller);

    /// @notice Thrown when a maker hook is invoked with a `maker` that is not this adapter.
    error HookMakerMismatch(address maker);

    /// @notice Thrown when a maker hook carries an `orderHash` that is not a live strategy this adapter
    ///         shipped. Binds hook execution to the adapter's own order book, not a taker-supplied hash.
    error HookUnknownOrder(bytes32 orderHash);

    /// @notice Thrown when a maker hook references a token that is not part of the named strategy.
    error HookTokenNotInStrategy(bytes32 strategyId, address token);

    /// @notice Thrown when a strategy is shipped against a class id not registered on the token's vault.
    error StrategyClassUnknown(uint256 classId);

    /// @notice Thrown when a shipped virtual reserve exceeds what its vault class can fund at pull time.
    error ShipExceedsVaultBacking(address token, uint256 classId, uint256 amount, uint256 idle);

    /// @notice Thrown when a maker hook the adapter does not implement is invoked. Only `preTransferOut` and
    ///         `postTransferIn` are enabled; the other two revert rather than silently no-op.
    error HookNotEnabled();

    /// @notice Thrown when a swap leg carries no substance (zero out on the OUT leg, or zero in / nothing
    ///         swept on the IN leg). Such a degenerate half-swap is rejected atomically so the two-hook settle
    ///         buffer is never left latched across swaps and no proceeds are stranded uncredited.
    error EmptySwapLeg();

    /// @notice Thrown when shipped strategy bytes do not decode to an order this adapter would author (wrong
    ///         maker, missing required hook bits, an unsupported hook bit, a redirected hook target, a custom
    ///         receiver, or a WETH-unwrap request).
    error InvalidStrategyTraits(uint256 traits);

    /// @notice Thrown when the shipped strategy bytes name a maker other than the adapter itself.
    error StrategyMakerMismatch(address maker);

    /// @notice Thrown when a class has no strategist set on a token's vault; a strategy cannot be authorized
    ///         against it.
    error ClassHasNoStrategist(uint256 classId);

    /// @notice Thrown when the tokens of one strategy resolve to different strategists across their vaults.
    ///         A class is one consent unit; a split strategist is a misconfiguration.
    error ClassStrategistMismatch(uint256 classId);

    /// @notice Thrown when a strategist signature does not recover to (or is not validated by) the class's
    ///         strategist. `SignatureChecker` covers both EOA and ERC-1271 smart-wallet signers.
    error NotStrategist(address strategist);

    /// @notice Thrown when a strategist-signed action carries the wrong sequential nonce (replay or out of
    ///         order).
    error StrategistNonceMismatch(address strategist, uint256 provided, uint256 expected);

    /// @notice Thrown when a strategist signature is presented after its deadline.
    error SignatureExpired(uint256 deadline, uint256 nowTs);

    /// @notice Thrown when `createVault` is called with a zero `assetId`. The id salts the vault's CREATE2
    ///         address, so a zero would collapse every asset onto one address.
    error ZeroAssetId();
}
