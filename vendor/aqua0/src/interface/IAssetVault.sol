// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Alloc } from "../lib/Types.sol";

/// @title IAssetVault
/// @author Aqua0 Team
/// @notice Consumer view of the multi-class vault used by the multi-class composer to move a class's
///         capital to and from venues and to mark settlement. Every capital/PnL entry point is keyed by
///         `classId`; all are gated to `COMPOSER_ROLE` on the vault.
interface IAssetVault {
    /// @notice The vault's single underlying ERC-20 asset.
    function asset() external view returns (address);

    /// @notice Whether `classId` has been registered on this vault.
    /// @dev Checked at ship time so a strategy bound to an unregistered class fails loudly at ship rather
    ///      than mid-swap inside a maker hook, where the only outcome is a reverted trader transaction.
    function classExists(uint256 classId) external view returns (bool);

    /// @notice The strategist authorized to sign strategies priced against `classId` (zero if unset).
    function classStrategist(uint256 classId) external view returns (address);

    /// @notice Move `amount` of `classId`'s idle out to `venue` as committed deployed principal.
    function deployCapital(uint256 classId, address venue, uint256 amount) external;

    /// @notice Return `amount` of `classId`'s principal from `venue`, pulled from the caller (FOT-safe).
    function returnCapital(uint256 classId, address venue, uint256 amount, bool finalClose) external;

    /// @notice Apply a venue adapter's realized same-chain PnL to `classId`'s deployed principal.
    function onAdapterSettle(uint256 classId, address adapter, int256 realizedPnL) external;

    /// @notice The deployable room for a strategy right now: `min(sharedIdle, committedBacking - deployed)`.
    ///         The upper bound a `VENUE_SETTLER` may net-send / a `deployCapital` may source for the strategy.
    /// @dev Re-pointed from the retired per-class `idleAssets(classId)` (which read a per-class idle balance)
    ///      to the shared-pool availability, so an adapter's ship-time precheck reads the shared idle bounded
    ///      by the strategy's remaining backing. The authoritative gate is still `settleVenueOut`'s own debit.
    function availableFor(uint256 strategyId) external view returns (uint256);

    /// @notice Sell `amount` of the vault's asset to `to` for a strategy's mid-swap OUT leg, sourcing it from
    ///         the strategy's committers' free principal. `VENUE_SETTLER`. Returns the `Alloc[]` of who sold how
    ///         much, which the adapter threads into the counter vault's `settleVenueCredit`.
    /// @dev Debits only free principal it holds + the single shared idle (INV-GLOBAL), so custody is safe
    ///      regardless of the downstream price. Reverts the whole trader swap if the strategy cannot fund it.
    /// @notice Record one filler's leg of a cross-chain front on this (destination) vault.
    /// @dev `COMPOSER_ROLE`. Filler consent is verified by the Composer before this is reached - see
    ///      `Composer._frontOpen`. Reverts `FillerFrontExclusive` if that filler already has an open front on
    ///      the strategy: a second would overwrite the first, orphaning an obligation and routing one
    ///      beneficiary's value to another.
    /// @param strategyId The destination strategy the front is attributed to.
    /// @param frontId The cross-chain front identifier, shared with the source chain's lock.
    /// @param filler The committer standing in.
    /// @param beneficiary The source-chain LP whose capital is bridging in.
    /// @param pledged The filler's allocation.
    /// @param feeOwed The filler's compensation, in this vault's asset.
    function openFrontObligation(
        uint256 strategyId,
        bytes32 frontId,
        address filler,
        address beneficiary,
        uint256 pledged,
        uint256 feeOwed
    ) external;

    function settleVenueOut(uint256 strategyId, address to, uint256 amount) external returns (Alloc[] memory alloc);

    /// @notice Credit a strategy's mid-swap IN leg to the sourcing committers named in `alloc`. `VENUE_SETTLER`.
    /// @dev FOT-safe. Each LP's proceeds (`drawn * refPriceRay`) accrue as their composition here; the spread
    ///      over the summed proceeds is the fee. `Σ proceeds <= received` bounds the credit to the physical
    ///      receipt, so a dishonest `refPriceRay` can never mint unbacked principal.
    function settleVenueCredit(uint256 strategyId, uint256 amount, Alloc[] calldata alloc, uint256 refPriceRay)
        external;

    /// @notice Fulfill (lock the price on) an async redeem request (`COMPOSER_ROLE`; driven via the signed
    ///         Composer spine so no EOA needs the role).
    function fulfillRedeem(uint256 requestId) external;

    /// @notice Reconcile a class/route's reported cross-chain PnL against the settled delta (`COMPOSER_ROLE`).
    function onBridgeSettle(uint256 classId, bytes32 route, bytes32 settlementId, int256 settledDelta) external;

    /// @notice Harden a cross-chain front lock Locked -> Committed for `frontId` on `classId` (`COMPOSER_ROLE`).
    /// @dev Backend calls this only after observing the lock finalized on this chain. From here LP-A's
    ///      self-cancel is disabled; a chain-B front for `frontId` must not be authorized until this succeeds.
    function commitFrontLock(uint256 classId, bytes32 frontId) external;

    /// @notice Strike, burn, meter, and release a committed front `frontId` toward the bridge (`COMPOSER_ROLE`).
    /// @dev Committed -> Released (terminal). Transfers the struck assets to the caller (the Composer), which
    ///      forwards them to the allowlisted bridge router. Returns the struck asset amount.
    function releaseFrontToBridge(uint256 classId, bytes32 frontId) external returns (uint256 assets);

    /// @notice Credit the MEASURED bridge landing `amount` pulled from the caller for front `frontId` to
    ///         `classId`'s idle (`COMPOSER_ROLE`). One-shot per `(classId, frontId, settlementId)`. A
    ///         shortfall against `lockedAmount` (the source chain's originally-struck amount) is written
    ///         down as a realized loss rather than silently dropped.
    /// @dev The caller (the Composer conduit) must hold the landed tokens and have approved this vault; the
    ///      vault books only the physically-received delta, so a signed `amount` can never inflate idle
    ///      beyond the real landing.
    function creditFrontLanding(
        uint256 classId,
        bytes32 frontId,
        bytes32 settlementId,
        uint256 amount,
        uint256 lockedAmount
    ) external;
}
