// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title IVaultRegistry
/// @author Aqua0 Team
/// @notice Consumer view of `VaultRegistry` used by the `VaultFactory` to register newly-created
///         vaults and by adapters/composer to resolve the asset->vault mapping and the trusted-adapter
///         allowlist.
interface IVaultRegistry {
    /// @notice Register `vault` as the canonical vault for `asset`. Reverts if `asset` already has one.
    function register(address asset, address vault) external;

    /// @notice Remove `vault` from the registry.
    function deregister(address vault) external;

    /// @notice The canonical vault for `asset`, or `address(0)` if none.
    function vaultForAsset(address asset) external view returns (address);

    /// @notice Whether `asset` has EVER had a vault, regardless of any later `deregister`.
    /// @dev The permanent partition the adapter/Composer rescue paths key on. `vaultForAsset` is clearable,
    ///      so keying the rescue guard on it alone let a `deregister` re-classify vault-backed capital as
    ///      sweepable dust. This flag is never cleared.
    function isVaultedAsset(address asset) external view returns (bool);

    /// @notice Whether `vault` is a registered Aqua0 vault.
    function isVault(address vault) external view returns (bool);

    /// @notice Whether `adapter` is on the trusted-adapter allowlist.
    function isAllowedAdapter(address adapter) external view returns (bool);

    /// @notice The registry-issued consent-class id for `strategyKey`, or 0 if none. The same id is used
    ///         across the per-asset vaults a strategy spans (a pair strategy is one class id in two vaults).
    function classForStrategy(bytes32 strategyKey) external view returns (uint256);

    /// @notice Issue and record the next monotonic class id for `strategyKey`. Reverts if already mapped.
    function registerStrategyClass(bytes32 strategyKey) external returns (uint256 classId);
}
