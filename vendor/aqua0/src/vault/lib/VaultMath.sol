// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Strategy } from "../../lib/Types.sol";

/// @title VaultMath
/// @author Aqua0 Team
/// @notice The per-strategy PnL-base, vesting, and share-price math for the shared-pool vault, factored into
///         ONE internal library so it is the SINGLE SOURCE OF TRUTH shared by `AssetVault` (its PnL views) and
///         `HybridPnLLib` (the delegatecall-linked reporter/reconcile block). These functions are `internal`,
///         so they inline into each caller's bytecode with NO delegatecall; the point is not to move bytecode
///         but to guarantee the vault and the PnL library can never diverge.
/// @dev Every function is a pure function of a `Strategy` and the caller's `vaultNow` (the vault clock:
///      wall-clock minus paused seconds, further frozen per-strategy inside `vestingNow`). Under the shared
///      pool a strategy holds NO custody; its `pnlBase` is its sourced-principal book (`deployed`) plus its
///      realized PnL pool (`pnlPool`), against which the per-epoch gain clamp is measured.
library VaultMath {
    /// @dev RAY (1e27) fixed-point unit for the per-strategy share price / fee accumulator.
    uint256 internal constant RAY = 1e27;

    /// @dev The vesting clock a single strategy sees: the vault clock, further frozen at `pausedAt` if that
    ///      strategy is individually paused. Taking the `min` (never `pausedAt` when it is somehow ahead of the
    ///      vault clock) keeps the clock monotone, so vesting can never jump backward.
    /// @param s The strategy whose vesting clock is read.
    /// @param vaultNow The vault clock (wall-clock minus vault-paused seconds).
    /// @return The effective vesting timestamp for `s` (frozen at its `pausedAt` while individually paused).
    function vestingNow(Strategy storage s, uint256 vaultNow) internal view returns (uint256) {
        if (!s.paused) return vaultNow;
        uint256 sp = s.pausedAt;
        return sp < vaultNow ? sp : vaultNow;
    }

    /// @dev The vested fraction of a strategy's active reporter gain window. Linear over `vestDuration` from
    ///      `vestStart` on the strategy's (pause-aware) vesting clock; fully vested (or a zero duration)
    ///      returns the whole `vestingGain`, and a clock at/behind `vestStart` returns 0. Pure arithmetic
    ///      (all subtractions are guarded by the ordering checks) so callers can never revert.
    /// @param s The strategy whose streaming gain is measured.
    /// @param vaultNow The vault clock passed through to the pause-aware vesting clock.
    /// @return The portion of `s.vestingGain` that has vested as of now.
    function vestedGain(Strategy storage s, uint256 vaultNow) internal view returns (uint256) {
        uint256 g = s.vestingGain;
        if (g == 0) return 0;
        uint256 dur = s.vestDuration;
        if (dur == 0) return g;
        uint256 nowTs = vestingNow(s, vaultNow);
        if (nowTs <= s.vestStart) return 0;
        uint256 elapsed = nowTs - s.vestStart;
        if (elapsed >= dur) return g;
        return Math.mulDiv(g, elapsed, dur);
    }

    /// @dev A strategy's PnL base, total-safe: sourced principal (`deployed`) + realized PnL pool + recognized
    ///      cross-chain PnL (crystallized plus the vested fraction of the streaming gain). Summed as `int256`
    ///      so a loss term can drive the total negative; the result floors at 0 and the math cannot revert.
    ///      This is the base the per-epoch upward gain clamp is measured against.
    /// @param s The strategy whose PnL base is computed.
    /// @param vaultNow The vault clock, forwarded to `vestedGain`.
    /// @return The non-negative PnL base of `s` at `vaultNow`.
    function pnlBase(Strategy storage s, uint256 vaultNow) internal view returns (uint256) {
        int256 total = int256(s.deployed) + s.pnlPool + s.xChainPnL + int256(vestedGain(s, vaultNow));
        return total > 0 ? uint256(total) : 0;
    }

    /// @dev A strategy's PnL base per unit of currently-deployed principal, in RAY. Returns RAY (1.0) when
    ///      nothing is deployed, so the divisor is never zero. A drift metric emitted with each report for
    ///      monitoring, NOT an accounting value: no capital math reads it.
    /// @param s The strategy whose share price is computed.
    /// @param vaultNow The vault clock, forwarded to `pnlBase`.
    /// @return The RAY-scaled PnL base per deployed unit (RAY when `s.deployed == 0`).
    function sharePriceRay(Strategy storage s, uint256 vaultNow) internal view returns (uint256) {
        uint256 deployed = s.deployed;
        if (deployed == 0) return RAY;
        return Math.mulDiv(pnlBase(s, vaultNow), RAY, deployed);
    }

    /// @dev Move the vested fraction of a strategy's `vestingGain` into crystallized PnL (`xChainPnL`).
    ///      `pnlBase` is unchanged by construction (value moves from the vested fraction of `vestingGain` into
    ///      the crystallized term, both already counted in the base); `vestingGain` is left holding ONLY
    ///      un-vested value, which is the one thing a later clawback may reverse. Callers re-base afterwards.
    /// @param s The strategy whose vested gain is crystallized (mutated in place).
    /// @param vaultNow The vault clock, forwarded to `vestedGain`.
    function crystallizeVestedGain(Strategy storage s, uint256 vaultNow) internal {
        uint256 vested = vestedGain(s, vaultNow);
        if (vested > 0) {
            s.xChainPnL += int256(vested);
            s.vestingGain -= vested;
        }
    }

    /// @dev Crystallize the vested fraction and re-base the vesting window onto the un-vested remainder,
    ///      preserving the original end time: `vestDuration` shrinks by the elapsed span and `vestStart` moves
    ///      to now, so `vestStart + vestDuration` is unchanged. A window fully elapsed collapses to duration 0
    ///      (the remainder vests instantly). Measured on the vault clock, not the pause-aware one.
    /// @param s The strategy whose vesting window is re-based (mutated in place).
    /// @param vaultNow The vault clock used both to crystallize and to advance `vestStart`.
    function rebaseVesting(Strategy storage s, uint256 vaultNow) internal {
        uint64 elapsed = vaultNow > s.vestStart ? uint64(vaultNow - s.vestStart) : 0;
        crystallizeVestedGain(s, vaultNow);
        s.vestDuration = elapsed >= s.vestDuration ? 0 : s.vestDuration - elapsed;
        s.vestStart = uint64(vaultNow);
    }
}
