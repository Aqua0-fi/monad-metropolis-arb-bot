// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title IVenueAdapter
/// @author Aqua0 Team
/// @notice Venue-agnostic contract every Aqua0 asset-vault venue adapter implements so the Composer and
///         the VaultRegistry can treat V4 and SwapVM adapters uniformly.
/// @dev Abstracts the TRIGGER model. A V4 adapter is hook-reactive (the PoolManager drives it through
///      `beforeSwap`/`afterSwap`); a SwapVM adapter is operator-driven (the Composer drives it through a
///      ship/dock lifecycle). Those venue-specific entry points are declared on the concrete adapters,
///      not here; this interface is only the common marker, venue identity, registry binding, and the
///      trigger + valuation classification the Composer uses to route per-venue triggering. Custody moves
///      and PnL settlement flow through the vault's Composer-gated seam (`deployCapital`/`returnCapital`/
///      `onAdapterSettle`), so no custody primitive lives on this interface. `VaultRegistry.setAdapterAllowed`
///      enforces both the `isVenueAdapter()` marker and the `registry()` binding on-chain at allowlist time,
///      so a foreign-bound or non-adapter contract cannot enter the allowlist.
interface IVenueAdapter {
    /// @notice How the venue's execution is triggered, so the Composer knows whether to drive the
    ///         adapter directly (operator) or to only pre-authorize and let the venue call back (hook).
    enum TriggerModel {
        HookReactive,
        OperatorDriven
    }

    /// @notice How the venue's value is reconciled, so the vault knows whether to trust push settlement or
    ///         to pull a live read.
    /// @dev `SettlementReported` (V4 + SwapVM today) realizes value via the vault's Composer-gated
    ///      settlement seam (`onAdapterSettle`), i.e. an event/report pushes realized PnL. `ReadValued` is
    ///      reserved for future venues whose positions appreciate silently and are valued by reading a
    ///      balance/price on demand (e.g. read-valued yield sources or priced venues). Such an adapter
    ///      additionally implements a separate read-valuation interface the vault pulls; deliberately NOT
    ///      declared here; so this base interface stays stable and existing adapters need no re-audit when
    ///      that track lands. This classifier is the only forward-compat hook; no valuation logic lives here.
    enum ValuationModel {
        SettlementReported,
        ReadValued
    }

    /// @notice Marker asserting this contract is an Aqua0 venue adapter. Must return true.
    function isVenueAdapter() external pure returns (bool);

    /// @notice Stable identifier for the venue this adapter mediates, e.g. `keccak256("V4")`.
    function venueId() external view returns (bytes32);

    /// @notice The VaultRegistry this adapter trusts for asset->vault resolution and its own allowlist
    ///         membership. Set at construction and immutable; `setAdapterAllowed` reverts unless this
    ///         returns the calling registry, so an adapter cannot be pointed at a foreign registry.
    function registry() external view returns (address);

    /// @notice The adapter's trigger model, letting the Composer pick the correct triggering path.
    function triggerModel() external view returns (TriggerModel);

    /// @notice The adapter's valuation model, letting the vault know whether value arrives via push
    ///         settlement (today) or by pulling a live read (future read-valued venues).
    function valuationModel() external view returns (ValuationModel);
}
