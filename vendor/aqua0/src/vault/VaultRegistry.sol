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
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import { Roles } from "../lib/Roles.sol";
import { Events } from "../lib/Events.sol";
import { Errors } from "../lib/Errors.sol";
import { IVenueAdapter } from "../interface/IVenueAdapter.sol";
import { IVaultRegistry } from "../interface/IVaultRegistry.sol";

/// @title VaultRegistry
/// @author Aqua0 Team
/// @notice Singleton, upgradeable (UUPS) source of truth for the vaults' asset->vault mapping and the
///         trusted-adapter allowlist.
/// @dev Two responsibilities:
///
///      1. ASSET->VAULT LOOKUP. One canonical vault per asset per chain. The `VaultFactory` (holding
///         `REGISTRAR_ROLE`) registers a vault on creation; a re-registration for an asset that
///         already has a vault reverts, so the "one vault per asset" invariant is enforced on-chain.
///
///      2. TRUSTED-ADAPTER ALLOWLIST. The set of venue adapters (V4 / SwapVM) the composer and vaults
///         are allowed to interact with. Admin-managed; adapters are added in a later phase.
///
///      Holds NO custody. Upgrade authority is the timelocked multisig (`UPGRADER_ROLE`).
contract VaultRegistry is Initializable, AccessControlUpgradeable, UUPSUpgradeable, IVaultRegistry {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @inheritdoc IVaultRegistry
    mapping(address => address) public vaultForAsset;

    /// @inheritdoc IVaultRegistry
    mapping(address => bool) public isVault;

    /// @inheritdoc IVaultRegistry
    mapping(address => bool) public isAllowedAdapter;

    /// @dev Enumerable set of every registered asset.
    EnumerableSet.AddressSet private _assets;
    /// @dev Enumerable set of every registered vault.
    EnumerableSet.AddressSet private _vaults;

    /// @inheritdoc IVaultRegistry
    // Written by `registerStrategyClass` (this file). Same upgradeable-contract false positive as the
    // factory's beacon: the detector counts constructor writes only.
    // slither-disable-next-line uninitialized-state
    mapping(bytes32 => uint256) public classForStrategy;

    /// @notice Last issued consent-class id (next issued is `+1`; 0 means "no class").
    uint256 public lastClassId;

    /// @inheritdoc IVaultRegistry
    /// @dev Write-once, never cleared, not even by `deregister`.
    mapping(address => bool) public isVaultedAsset;

    /// @dev Reserves 42 slots for future variables. Inherited OZ contracts use ERC-7201 namespaced storage
    ///      and do not consume these linear slots. Not frozen until the first mainnet deploy (see layout/).
    uint256[42] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the singleton proxy.
    /// @param admin     Receives `DEFAULT_ADMIN_ROLE` (manages the adapter allowlist, grants roles).
    /// @param registrar Receives `REGISTRAR_ROLE` (the `VaultFactory`).
    /// @param upgrader  Receives `UPGRADER_ROLE` (the timelocked multisig).
    function initialize(address admin, address registrar, address upgrader) external initializer {
        require(admin != address(0) && registrar != address(0) && upgrader != address(0), Errors.ZeroAddress());
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.REGISTRAR_ROLE, registrar);
        _grantRole(Roles.UPGRADER_ROLE, upgrader);
        // Self-administered: only an existing UPGRADER_ROLE holder can grant/revoke it, so DEFAULT_ADMIN_ROLE
        // alone can no longer self-grant upgrade authority over this contract. REGISTRAR_ROLE stays
        // DEFAULT_ADMIN_ROLE-administered: the deploy bootstrap re-points
        // it from a placeholder registrar to the real VaultFactory address as a normal part of the single
        // deploy flow, under the bootstrap deployer's DEFAULT_ADMIN_ROLE, before UPGRADER_ROLE (the
        // timelock) is even reachable in that same flow.
        _setRoleAdmin(Roles.UPGRADER_ROLE, Roles.UPGRADER_ROLE);
    }

    // ============================================================
    // Registration (factory-gated)
    // ============================================================

    /// @inheritdoc IVaultRegistry
    function register(address asset, address vault) external onlyRole(Roles.REGISTRAR_ROLE) {
        require(asset != address(0) && vault != address(0), Errors.ZeroAddress());
        address existing = vaultForAsset[asset];
        require(existing == address(0), Errors.AssetAlreadyHasVault(asset, existing));

        vaultForAsset[asset] = vault;
        isVault[vault] = true;
        // Permanent: a later `deregister` must never be able to re-classify this asset as unvaulted dust.
        isVaultedAsset[asset] = true;
        _assets.add(asset);
        _vaults.add(vault);

        emit Events.VaultRegistered(asset, vault);
    }

    /// @inheritdoc IVaultRegistry
    /// @dev Gated to `UPGRADER_ROLE` (the timelocked multisig), NOT `REGISTRAR_ROLE`. Registration is a
    ///      routine factory op; DEregistration retires a vault and clears its `vaultForAsset` edge, which is
    ///      one half of the rescue partition. Under `REGISTRAR_ROLE`, whose role admin is DEFAULT_ADMIN, a
    ///      single admin key could grant itself the role, deregister a live vault, and then sweep its asset
    ///      out of the adapters as "unvaulted dust". The upgrader can already replace this implementation
    ///      outright, so gating here grants it no new authority and takes one away from the admin.
    ///
    ///      `isVaultedAsset` is deliberately NOT cleared: the rescue partition keys on that flag, so even a
    ///      timelocked deregistration can never re-classify vault-backed capital as sweepable.
    function deregister(address vault) external onlyRole(Roles.UPGRADER_ROLE) {
        require(isVault[vault], Errors.VaultNotRegistered(vault));

        // Find and clear the asset->vault edge. The asset set is small (one vault per asset), so this
        // is bounded. We do not know the asset from the vault alone, so scan the asset set.
        uint256 n = _assets.length();
        for (uint256 i; i < n; ++i) {
            address asset = _assets.at(i);
            if (vaultForAsset[asset] == vault) {
                delete vaultForAsset[asset];
                _assets.remove(asset);
                emit Events.VaultDeregistered(asset, vault);
                break;
            }
        }

        isVault[vault] = false;
        _vaults.remove(vault);
    }

    // ============================================================
    // Strategy -> class id (registry-issued, monotonic)
    // ============================================================

    /// @inheritdoc IVaultRegistry
    /// @dev Permissionless. Issues the next monotonic class id and records it for `strategyKey`, so a pair
    ///      strategy resolves to the SAME id across the per-asset vaults it spans (the caller then registers
    ///      that id as a class on each vault). Re-registering a key reverts.
    ///
    ///      Opened up to match the permissionless strategy-creation flow: `AssetVault.registerStrategy` is
    ///      itself permissionless, so gating the id issuer here would bottleneck it. This is safe because the
    ///      function holds no custody and grants no authority: the id is a pure label. It does not bind a
    ///      strategist (that happens in `AssetVault.registerStrategy` under the strategist's own signature),
    ///      and reaching a class id first only lets the caller occupy that number - the legit flow simply reads
    ///      the existing `classForStrategy[strategyKey]` and uses it. The only surface is monotonic-counter
    ///      griefing, which a uint256 counter makes a non-issue.
    function registerStrategyClass(bytes32 strategyKey) external returns (uint256 classId) {
        uint256 existing = classForStrategy[strategyKey];
        require(existing == 0, Errors.StrategyClassAlreadyRegistered(strategyKey, existing));

        classId = ++lastClassId;
        classForStrategy[strategyKey] = classId;
        emit Events.StrategyClassRegistered(strategyKey, classId);
    }

    // ============================================================
    // Adapter allowlist (admin-gated)
    // ============================================================

    /// @notice Add or remove `adapter` from the trusted-adapter allowlist.
    /// @dev Adding validates the adapter on-chain: it must answer the `IVenueAdapter` marker with `true`
    ///      and declare THIS registry as its binding, so a foreign-bound or non-adapter contract can never
    ///      be allowlisted. Removal skips validation; a broken or self-bricking adapter must always be
    ///      removable, and removal only ever narrows authority.
    /// @param adapter The venue adapter to add to or remove from the trusted-adapter allowlist.
    /// @param allowed `true` to add (validated on-chain), `false` to remove (unconditional).
    function setAdapterAllowed(address adapter, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(adapter != address(0), Errors.ZeroAddress());

        if (allowed) {
            // `try` cannot catch this: for a call with a return value the compiler asserts `extcodesize > 0`
            // before dispatching, so a codeless address reverts outside the try/catch frame.
            require(adapter.code.length > 0, Errors.NotAqua0Adapter(adapter));

            try IVenueAdapter(adapter).isVenueAdapter() returns (bool ok) {
                require(ok, Errors.NotAqua0Adapter(adapter));
            } catch {
                revert Errors.NotAqua0Adapter(adapter);
            }

            address bound = IVenueAdapter(adapter).registry();
            require(bound == address(this), Errors.AdapterRegistryMismatch(adapter, bound));
        }

        isAllowedAdapter[adapter] = allowed;
        emit Events.AdapterAllowlisted(adapter, allowed);
    }

    // ============================================================
    // Enumeration views
    // ============================================================

    /// @notice Every registered asset.
    /// @return The full list of asset token addresses registered across the vaults.
    function allAssets() external view returns (address[] memory) {
        return _assets.values();
    }

    /// @notice Every registered vault.
    /// @return The full list of vault addresses registered across the vaults.
    function allVaults() external view returns (address[] memory) {
        return _vaults.values();
    }

    /// @notice Number of registered vaults.
    /// @return The count of vaults registered in the registry.
    function vaultCount() external view returns (uint256) {
        return _vaults.length();
    }

    // ============================================================
    // Upgrade authority
    // ============================================================

    /// @dev UUPS upgrade authority. Gated to `UPGRADER_ROLE` (the timelocked multisig).
    /// @param newImplementation The candidate implementation the proxy would point at; authority is role-gated
    ///        here, and the implementation itself is validated by the ERC-1967 upgrade machinery.
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(Roles.UPGRADER_ROLE) { }
}
