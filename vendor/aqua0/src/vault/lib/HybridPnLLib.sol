// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import { Strategy } from "../../lib/Types.sol";
import { VaultMath } from "./VaultMath.sol";
import { Events } from "../../lib/Events.sol";
import { Errors } from "../../lib/Errors.sol";

/// @title HybridPnLLib
/// @author Aqua0 Team
/// @notice Delegatecall-linked logic library for the hybrid cross-chain PnL block (`report` /
///         `onBridgeSettle`), re-homed from the retired per-class `Class` onto the shared-pool `Strategy`
///         record. The clamp / vesting / claw discipline is reused wholesale; only the storage it reads/writes
///         changed from a per-class custody struct to the per-strategy PnL terms. Every function is `external`
///         (deployed once, delegatecalled by the vault), so its bytecode leaves the vault's own runtime while
///         the state it mutates stays in the vault's storage.
/// @dev NO STORAGE OF ITS OWN. The share-price / vesting math is NOT re-derived here: it uses the SAME
///      `VaultMath` internal library the vault uses, so the two can never diverge. The vault owns the clock and
///      passes `vaultNow` (and, for `report`, `vaultPaused`). The recognized cross-chain delta lands on the
///      strategy's `xChainPnL` / `vestingGain`; a settled loss is netted at reconcile. The precise per-committer
///      split of a recognized strategy PnL onto the pool shares is deferred; the beta keeps the reporter's
///      containment properties (immediate unclamped loss, clamped/vested gain, one-shot settle, over-report
///      claw) intact against the strategy record.
library HybridPnLLib {
    /// @dev MUST equal `AssetVault.MAX_EPOCH_ADVANCE`. The furthest a single report may advance a strategy's
    ///      monotonic epoch, so one compromised report cannot ratchet the counter to `type(uint64).max`.
    uint64 internal constant MAX_EPOCH_ADVANCE = 10_000;

    /// @notice Recognize a strategy's in-flight cross-chain delta for `route`. Losses land immediately +
    ///         unclamped (even while paused); an upward gain opens a fresh clamp/vesting window bounded by
    ///         `maxBpsPerEpoch`, and is forbidden while the vault or strategy is paused/vetoed.
    /// @dev Reverts if the strategy does not exist, if it is reporter-frozen (guardian veto), if the epoch does
    ///      not strictly advance or jumps beyond `MAX_EPOCH_ADVANCE`, or (gain only) if the vault or strategy is
    ///      paused. A loss / zero delta returns early and never opens a vesting window.
    /// @param strategies The vault's strategyId -> Strategy PnL record.
    /// @param routeReportedLoss Per (strategy, route) in-flight loss already recognized (netted at settle).
    /// @param routeReportedGain Per (strategy, route) clamped gain currently reported (clawed at settle).
    /// @param strategyId The strategy whose delta is being recognized.
    /// @param epoch The reporter's monotonic report epoch; must strictly exceed the last one.
    /// @param route The bridge route this in-flight delta is attributed to.
    /// @param xChainDelta Signed in-flight PnL: negative = loss (immediate, unclamped), positive = clamped gain.
    /// @param vaultNow The vault clock (pause-adjusted) driving the clamp / vesting math.
    /// @param vaultPaused Whether the whole vault is paused; blocks an upward gain mark.
    /// @param epochLength Clamp / vesting window length in seconds for a fresh gain window.
    /// @param maxBpsPerEpoch Upward rate cap (bps of the strategy's PnL base) applied to a gain this epoch.
    function report(
        mapping(uint256 => Strategy) storage strategies,
        mapping(uint256 => mapping(bytes32 => uint256)) storage routeReportedLoss,
        mapping(uint256 => mapping(bytes32 => uint256)) storage routeReportedGain,
        uint256 strategyId,
        uint64 epoch,
        bytes32 route,
        int256 xChainDelta,
        uint256 vaultNow,
        bool vaultPaused,
        uint64 epochLength,
        uint16 maxBpsPerEpoch
    ) external {
        require(strategies[strategyId].exists, Errors.ClassNotRegistered(strategyId));
        Strategy storage s = strategies[strategyId];
        // A guardian veto freezes reporting for the strategy; no delta (loss or gain) may be recognized.
        require(!s.reporterFrozen, Errors.ReporterFrozen(strategyId));
        // Bump the monotonic epoch first (bounded jump), so every branch below runs at the new epoch.
        _advanceEpoch(s, epoch);

        // Losses are recognized immediately and unclamped, and are allowed EVEN WHILE THE STRATEGY IS PAUSED (a
        // down-mark keeps a frozen strategy's price honest so a pending timeout redeem is never trapped at a
        // stale-high mark). They never open a clamp/vesting window.
        if (xChainDelta < 0) {
            // Recognize the loss immediately onto `xChainPnL` and accumulate it per route so `onBridgeSettle`
            // can net it against the actual settled loss (debit the ACTUAL loss exactly once).
            s.xChainPnL += xChainDelta;
            routeReportedLoss[strategyId][route] += uint256(-xChainDelta);
            emit Events.ClassPnLReported(
                address(this), strategyId, epoch, xChainDelta, VaultMath.sharePriceRay(s, vaultNow)
            );
            return;
        }
        if (xChainDelta == 0) {
            // A zero delta is a heartbeat: it advances the epoch and re-emits the price, nothing more.
            emit Events.ClassPnLReported(address(this), strategyId, epoch, 0, VaultMath.sharePriceRay(s, vaultNow));
            return;
        }

        // An upward gain up-marks the share price; forbidden while the vault or strategy is paused/vetoed.
        require(!vaultPaused, PausableUpgradeable.EnforcedPause());
        require(!s.paused, Errors.ClassIsPaused(strategyId));
        _applyClampedGain(
            s, strategyId, epoch, route, uint256(xChainDelta), vaultNow, epochLength, maxBpsPerEpoch, routeReportedGain
        );
    }

    /// @notice Reconcile a strategy/route's reported gain against the actual settled delta on bridge landing,
    ///         clawing an over-report beyond tolerance from the strategy's UNVESTED gain only, and netting a
    ///         reported loss against the settled loss. Composer-gated + one-shot per `(strategyId, route,
    ///         settlementId)`.
    /// @dev The one-shot key is `keccak256(strategyId, route, settlementId)`: a re-signed duplicate landing
    ///      carries a fresh Composer nonce, so replay protection must key on the bridge landing identity, not the
    ///      nonce. Reverts on a zero `settlementId`, an already-consumed key, or a paused strategy. Only ever
    ///      SUBTRACTS from `vestingGain` (claw) and nets the loss onto `xChainPnL`; it never up-marks.
    /// @param strategies The vault's strategyId -> Strategy PnL record.
    /// @param settlementConsumed The vault's one-shot ledger keyed by `(strategyId, route, settlementId)`.
    /// @param routeReportedGain Per (strategy, route) reported gain; consumed (zeroed) here.
    /// @param routeReportedLoss Per (strategy, route) reported loss; consumed (zeroed) here.
    /// @param strategyId The strategy being reconciled.
    /// @param route The bridge route being reconciled.
    /// @param settlementId The bridge landing id (the idempotency key); must be non-zero and unused.
    /// @param settledDelta The actual settled bridge delta (signed) to reconcile against the reported figure.
    /// @param vaultNow The vault clock driving the vesting rebase before the claw.
    /// @param reconcileToleranceBps Slack (bps of the reported gain) below which an over-report is not clawed.
    function onBridgeSettle(
        mapping(uint256 => Strategy) storage strategies,
        mapping(bytes32 => bool) storage settlementConsumed,
        mapping(uint256 => mapping(bytes32 => uint256)) storage routeReportedGain,
        mapping(uint256 => mapping(bytes32 => uint256)) storage routeReportedLoss,
        uint256 strategyId,
        bytes32 route,
        bytes32 settlementId,
        int256 settledDelta,
        uint256 vaultNow,
        uint16 reconcileToleranceBps
    ) external {
        require(strategies[strategyId].exists, Errors.ClassNotRegistered(strategyId));
        require(!strategies[strategyId].paused, Errors.ClassIsPaused(strategyId));

        require(settlementId != bytes32(0), Errors.ZeroSettlementId());
        // One-shot key on the bridge LANDING identity (not the Composer nonce, which differs on a re-sign).
        bytes32 key = keccak256(abi.encode(strategyId, route, settlementId));
        require(!settlementConsumed[key], Errors.SettlementAlreadyConsumed(strategyId, route, settlementId));
        settlementConsumed[key] = true;

        Strategy storage s = strategies[strategyId];
        // Consume the route's reported gain; a second settle for the route sees 0 and cannot double-claw.
        uint256 reported = routeReportedGain[strategyId][route];
        routeReportedGain[strategyId][route] = 0;
        uint256 actualGain = settledDelta > 0 ? uint256(settledDelta) : 0;

        // Crystallize vested gain to `vaultNow` first, so the claw only ever touches the UNVESTED remainder.
        VaultMath.rebaseVesting(s, vaultNow);
        int256 clawback = _clawOverReport(s, reported, actualGain, reconcileToleranceBps);
        int256 netting = _netReportedLoss(s, strategyId, route, settledDelta, routeReportedLoss);

        emit Events.ClassBridgeSettled(address(this), strategyId, route, settlementId, settledDelta, netting);

        if (reported != actualGain || settledDelta < 0 || netting != 0) {
            emit Events.ClassReconciliationMismatch(
                address(this), strategyId, route, int256(reported), settledDelta, -clawback
            );
        }
    }

    /// @dev Open a fresh clamp/vesting window and stream in `gain`, bounded by the per-epoch upward rate. A
    ///      fresh clamp window may open only once the previous one has fully elapsed (measured on the vault
    ///      clock), so N same-block reports cannot stack N full clamps. Crystallizes any already-vested gain
    ///      first, then applies `min(gain, base * maxBpsPerEpoch / 10_000)` and OVERWRITES the route's reported
    ///      gain (a fresh window is a fresh cycle, not an accumulation).
    /// @param s The strategy PnL record being up-marked.
    /// @param strategyId The strategy id (event context).
    /// @param epoch The report epoch (event context).
    /// @param route The bridge route whose reported gain is (over)written to the applied amount.
    /// @param gain The requested upward gain before the per-epoch clamp.
    /// @param vaultNow The vault clock anchoring the new vest/clamp window.
    /// @param epochLength The vest / clamp window duration in seconds.
    /// @param maxBpsPerEpoch The upward rate cap (bps of the strategy's PnL base) for this window.
    /// @param routeReportedGain Per (strategy, route) reported gain; overwritten with the clamped applied amount.
    function _applyClampedGain(
        Strategy storage s,
        uint256 strategyId,
        uint64 epoch,
        bytes32 route,
        uint256 gain,
        uint256 vaultNow,
        uint64 epochLength,
        uint16 maxBpsPerEpoch,
        mapping(uint256 => mapping(bytes32 => uint256)) storage routeReportedGain
    ) private {
        // A fresh window may open only once the previous clamp window has fully elapsed, so N same-block
        // reports cannot stack N full clamps.
        require(
            s.clampWindowStart == 0 || vaultNow >= uint256(s.clampWindowStart) + epochLength,
            Errors.PnLEpochNotElapsed(s.clampWindowStart + epochLength, uint64(vaultNow))
        );

        // Bank whatever the prior window already vested before re-anchoring the vest/clamp clocks to now.
        VaultMath.crystallizeVestedGain(s, vaultNow);
        s.vestStart = uint64(vaultNow);
        s.vestDuration = epochLength;
        s.clampWindowStart = uint64(vaultNow);

        // Clamp the gain to `base * maxBpsPerEpoch / 10_000`; a hit means the excess is deferred, not lost.
        uint256 applied = Math.min(gain, Math.mulDiv(VaultMath.pnlBase(s, vaultNow), maxBpsPerEpoch, 10_000));
        if (applied < gain) {
            emit Events.ClassClampHit(address(this), strategyId, epoch, int256(gain), int256(applied));
        }

        s.vestingGain += applied;
        // OVERWRITE, not accumulate: a fresh clamp window is a fresh gain cycle for this route.
        routeReportedGain[strategyId][route] = applied;
        emit Events.ClassPnLReported(
            address(this), strategyId, epoch, int256(applied), VaultMath.sharePriceRay(s, vaultNow)
        );
    }

    /// @dev Advance a strategy's monotonic report epoch, bounding the jump so one compromised report cannot
    ///      ratchet the counter to `type(uint64).max` and brick reporting for the strategy. Reverts if `epoch`
    ///      does not strictly exceed the last one, or exceeds `lastReportedEpoch + MAX_EPOCH_ADVANCE`.
    /// @param s The strategy whose epoch counter advances.
    /// @param epoch The new epoch; must be in `(lastReportedEpoch, lastReportedEpoch + MAX_EPOCH_ADVANCE]`.
    function _advanceEpoch(Strategy storage s, uint64 epoch) private {
        require(epoch > s.lastReportedEpoch, Errors.PnLEpochNotAdvanced(epoch, s.lastReportedEpoch));
        uint64 maxEpoch = s.lastReportedEpoch + MAX_EPOCH_ADVANCE;
        require(epoch <= maxEpoch, Errors.PnLEpochJumpTooLarge(epoch, maxEpoch));
        s.lastReportedEpoch = epoch;
    }

    /// @dev Claw an over-report beyond tolerance from the strategy's UNVESTED gain only (callers crystallize
    ///      first). Only ever SUBTRACTS from `vestingGain`, never adds, so a stale reported figure is inert.
    ///      The claw is capped at the strategy's remaining `vestingGain`, so already-vested gain (in the price)
    ///      is never retroactively confiscated from LPs.
    /// @param s The strategy whose unvested gain is clawed.
    /// @param reported The gain previously reported for this route.
    /// @param actualGain The actual settled gain (0 if the settled delta was a loss).
    /// @param reconcileToleranceBps Slack (bps of the reported gain) the over-report may exceed uncharged.
    /// @return The amount clawed from `vestingGain` (0 if within tolerance or nothing left to claw).
    function _clawOverReport(Strategy storage s, uint256 reported, uint256 actualGain, uint16 reconcileToleranceBps)
        private
        returns (int256)
    {
        // No over-report (settled >= reported): nothing to claw.
        if (reported <= actualGain) return 0;
        uint256 over = reported - actualGain;
        // Allow a tolerance band (bps of the reported figure) before clawing, to absorb benign rounding.
        uint256 tol = Math.mulDiv(reported, reconcileToleranceBps, 10_000);
        if (over <= tol) return 0;
        uint256 excess = over - tol;
        // Cap the claw at the unvested remainder: already-vested gain (in the price) is never confiscated.
        uint256 claw = excess > s.vestingGain ? s.vestingGain : excess;
        s.vestingGain -= claw;
        return int256(claw);
    }

    /// @dev Net the in-flight loss the reporter already recognized for `(strategy, route)` against the settled
    ///      loss, so the strategy is debited exactly the ACTUAL loss once. Returns the correction delta. Consumes
    ///      (zeroes) the reported loss so a second settle for the same route cannot double-net.
    /// @param s The strategy whose `xChainPnL` absorbs the correction.
    /// @param strategyId The strategy being reconciled.
    /// @param route The bridge route being reconciled.
    /// @param settledDelta The settled bridge delta; its negative part is the actual loss.
    /// @param routeReportedLoss Per (strategy, route) reported loss; zeroed here.
    /// @return netting `reportedLoss - settledLoss`: the signed correction applied to `xChainPnL` (0 if equal).
    function _netReportedLoss(
        Strategy storage s,
        uint256 strategyId,
        bytes32 route,
        int256 settledDelta,
        mapping(uint256 => mapping(bytes32 => uint256)) storage routeReportedLoss
    ) private returns (int256 netting) {
        // Consume the reported loss (zero it) so a re-settle for the route cannot double-net.
        uint256 reportedLoss = routeReportedLoss[strategyId][route];
        routeReportedLoss[strategyId][route] = 0;
        uint256 settledLoss = settledDelta < 0 ? uint256(-settledDelta) : 0;
        // Correction = reported - settled: adds back an over-reported loss, or debits an under-reported one.
        netting = int256(reportedLoss) - int256(settledLoss);
        if (netting != 0) s.xChainPnL += netting;
    }
}
