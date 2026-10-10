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
import { BeaconProxy } from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import { Roles } from "../lib/Roles.sol";
import { Events } from "../lib/Events.sol";
import { Errors } from "../lib/Errors.sol";
import { AssetVault } from "./AssetVault.sol";
import { IVaultRegistry } from "../interface/IVaultRegistry.sol";

/// @title VaultFactory
/// @author Aqua0 Team
/// @notice Singleton, upgradeable (UUPS) deployer of the `AssetVault` beacon-proxy vaults and the
///         vault-wide emergency stop.
/// @dev Responsibilities:
///
///      1. VAULT DEPLOYMENT. `createVault` deploys a `BeaconProxy` pointing at the shared
///         `UpgradeableBeacon` (the vaults' single upgrade authority, owned by the timelocked
///         multisig; the factory does NOT own the beacon) and initializes it. Because the factory is
///         the deployer, `AssetVault.initialize` also grants the factory `PAUSER_ROLE` on the new
///         vault, which is what makes `pauseAll` possible.
///
///      2. REGISTRATION. The factory holds `REGISTRAR_ROLE` on the `VaultRegistry` and registers each
///         vault so the "one vault per asset" invariant is enforced at the registry.
///
///      3. VAULT-WIDE EMERGENCY STOP. `pauseAll` atomically pauses every vault the factory created
///         (`PAUSER_ROLE`). Individual `unpause` remains admin-only on each vault.
///
///      Holds NO custody.
contract VaultFactory is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Salt namespace for the vaults' CREATE2 vault addresses. Bumping it re-addresses the vaults.
    bytes32 public constant VAULT_SALT_NS = keccak256("aqua0.asset-vault.v1");

    /// @notice The shared `UpgradeableBeacon` all vault proxies point at. Owned by the timelocked
    ///         multisig (NOT this factory); it is the sole upgrade authority for the asset vaults.
    // Set in `initialize`, which is where a UUPS proxy initializes. `uninitialized-state` looks only
    // at constructors, and this contract deliberately has none.
    // slither-disable-next-line uninitialized-state
    address public beacon;

    /// @notice The `VaultRegistry` singleton this factory registers vaults into.
    address public registry;

    /// @dev Enumerable set of every vault this factory created (used by `pauseAll`).
    EnumerableSet.AddressSet private _vaults;

    /// @dev Reserved storage for append-only upgrades. Inherited OZ contracts use ERC-7201 namespaced
    ///      storage and do not consume these linear slots. Grown by one when the former `indexer` slot was
    ///      removed, keeping the reserved footprint constant.
    uint256[45] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the singleton proxy.
    /// @param admin     Receives `DEFAULT_ADMIN_ROLE` (creates vaults, manages wiring).
    /// @param pauser    Receives `PAUSER_ROLE` (may call `pauseAll`).
    /// @param upgrader  Receives `UPGRADER_ROLE` (the timelocked multisig).
    /// @param beacon_   The shared vault `UpgradeableBeacon`.
    /// @param registry_ The `VaultRegistry` singleton.
    function initialize(address admin, address pauser, address upgrader, address beacon_, address registry_)
        external
        initializer
    {
        require(
            admin != address(0) && pauser != address(0) && upgrader != address(0) && beacon_ != address(0)
                && registry_ != address(0),
            Errors.ZeroAddress()
        );
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.PAUSER_ROLE, pauser);
        _grantRole(Roles.UPGRADER_ROLE, upgrader);
        // Self-administered: only an existing UPGRADER_ROLE holder can grant/revoke it, so DEFAULT_ADMIN_ROLE
        // alone can no longer self-grant upgrade authority over this contract.
        _setRoleAdmin(Roles.UPGRADER_ROLE, Roles.UPGRADER_ROLE);

        beacon = beacon_;
        registry = registry_;
    }

    // ============================================================
    // Vault creation
    // ============================================================

    /// @notice Deploy and register a new `AssetVault` beacon proxy for `asset` at a SALT-DERIVED address.
    ///
    /// @dev CREATE2, not CREATE. Under plain `new BeaconProxy(...)` the vault address derives from the
    ///      FACTORY'S NONCE, so it depends on how many vaults were created before it and in what order. The
    ///      vaults' cross-chain-identical-address property then held only by accident; every chain
    ///      happened to create `usdc` then `weth`; and creating a third vault on one chain first would have
    ///      permanently diverged every later vault. Salting on `assetId` removes order and count from the
    ///      derivation entirely.
    ///
    ///      `assetId` is a CHAIN-INVARIANT identifier (e.g. `keccak256("USDC")`), deliberately NOT the token
    ///      address: USDC lives at a different address on every chain, so salting on the address would
    ///      re-diverge the very thing this fixes.
    ///
    ///      THE EMPTY `initData` IS LOAD-BEARING. It used to embed `IERC20(asset)`, a per-chain address ,
    ///      in the proxy's constructor arguments, which are part of the CREATE2 init code and therefore of
    ///      the address. Passing `""` makes `ERC1967Utils.upgradeBeaconToAndCall` skip the delegatecall, so
    ///      the init code is `BeaconProxy.creationCode ++ abi.encode(beacon, "")`; identical on every chain,
    ///      because `beacon` is itself a CreateX CREATE3 singleton at a matching address.
    ///
    ///      DEPLOY AND INITIALIZE MUST STAY IN ONE TRANSACTION. Between `new BeaconProxy` and `initialize`
    ///      the proxy is live and uninitialized. Split across two transactions, anyone could front-run the
    ///      `initialize` and take `DEFAULT_ADMIN_ROLE` on a vault whose address we published in advance;
    ///      and `computeVaultAddress` publishes it. They are two statements in one function body. Keep them
    ///      that way.
    ///
    /// @param assetId     Chain-invariant id for the asset (e.g. `keccak256("USDC")`). Salts the address.
    /// @param asset       The underlying ERC-20 asset (one vault per asset; the registry enforces it).
    /// @param name        Share-token name (e.g. "Aqua0 USDC Vault").
    /// @param symbol      Share-token symbol (e.g. "aqUSDC").
    /// @param vaultAdmin  Receives `DEFAULT_ADMIN_ROLE` on the new vault (tunes guards, unpauses).
    /// @param vaultPauser Receives `PAUSER_ROLE` on the new vault (the independent pause-only relayer).
    /// @return vault      The deployed vault proxy address (== `computeVaultAddress(assetId)`).
    /// @param venueOutflowLimit The vault's mid-swap net-outflow budget per window. Must be non-zero: a vault
    ///        is never created unmetered (`AssetVault.initialize` enforces it).
    function createVault(
        bytes32 assetId,
        address asset,
        string calldata name,
        string calldata symbol,
        address vaultAdmin,
        address vaultPauser,
        uint256 venueOutflowLimit
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (address vault) {
        require(asset != address(0) && vaultAdmin != address(0) && vaultPauser != address(0), Errors.ZeroAddress());
        require(assetId != bytes32(0), Errors.ZeroAssetId());

        // A repeated `assetId` makes CREATE2 revert on an already-taken address. That is the behaviour we
        // want: vault addresses are a pure function of `assetId`, so a collision IS a configuration error.
        vault = address(new BeaconProxy{ salt: _vaultSalt(assetId) }(beacon, ""));

        // Same transaction as the deploy. See the front-running note above.
        AssetVault(vault).initialize(IERC20(asset), name, symbol, vaultAdmin, vaultPauser, venueOutflowLimit);

        _vaults.add(vault);

        // Enforce one-vault-per-asset and add to the vault allowlist adapters trust.
        IVaultRegistry(registry).register(asset, vault);

        emit Events.VaultCreated(asset, vault, name, symbol);
    }

    /// @notice The address `createVault(assetId, …)` will deploy to. Depends only on this factory and
    ///         `assetId`; never on creation order, creation count, or the chain's token addresses.
    /// @dev The deploy script asserts against this before broadcasting, and off-chain tooling can resolve a
    ///      vault address on a chain where the vaults have not been deployed yet.
    /// @param assetId The asset identifier the vault would be created for.
    /// @return The deterministic CREATE2 address `createVault(assetId, …)` deploys the vault to.
    function computeVaultAddress(bytes32 assetId) public view returns (address) {
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(BeaconProxy).creationCode, abi.encode(beacon, "")));
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _vaultSalt(assetId), initCodeHash)))
            )
        );
    }

    /// @dev Namespaced so a future vault version can re-address without colliding with the live one.
    /// @param assetId The asset identifier the salt is derived for.
    /// @return The namespaced CREATE2 salt used for this asset's vault BeaconProxy.
    function _vaultSalt(bytes32 assetId) internal pure returns (bytes32) {
        return keccak256(abi.encode(VAULT_SALT_NS, assetId));
    }

    // ============================================================
    // Vault-wide emergency stop
    // ============================================================

    /// @notice Atomically pause every vault this factory created. Already-paused vaults are skipped
    ///         (try/catch) so one does not block the rest.
    function pauseAll() external onlyRole(Roles.PAUSER_ROLE) {
        uint256 n = _vaults.length();
        for (uint256 i; i < n; ++i) {
            try AssetVault(_vaults.at(i)).pause() { } catch { }
        }
        emit Events.PausedAll(msg.sender);
    }

    // ============================================================
    // Views + wiring administration
    // ============================================================

    /// @notice Every vault this factory has created.
    /// @return The full list of vault addresses created by this factory.
    function vaults() external view returns (address[] memory) {
        return _vaults.values();
    }

    /// @notice Number of vaults this factory has created.
    /// @return The count of vaults created by this factory.
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
