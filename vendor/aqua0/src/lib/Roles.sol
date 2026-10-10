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

/// @title Roles
/// @author Aqua0 Team
/// @notice Canonical `AccessControl` role identifiers for the Aqua0 asset vaults and singletons.
/// @dev Library of role-id constants so every upgradeable contract references ONE definition
///      (the VaultFactory, VaultRegistry, Composer, and the asset vaults). A role id is
///      `keccak256(name)`; the value depends only on the string,
///      not on where it is declared, so off-chain tooling (the automated monitor, the brain, and
///      the docs) can precompute these hashes from the names below. `DEFAULT_ADMIN_ROLE` (0x00) is
///      provided by `AccessControlUpgradeable` and is the role admin for all of these unless re-wired.
///
///      Do NOT change these strings once any contract holding a live grant is deployed. The hash is
///      the on-chain role key, so a renamed string silently orphans every existing grant.
library Roles {
    /// @notice Emergency pause authority. Held by the pause-only automated relayer (key custodied in
    ///         a KMS, least-privilege: can ONLY pause), so the monitored auto-remediation path is not
    ///         a dangerous standing key. Used by every pausable contract in the suite.
    bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Upgrade authority (UUPS and the vault beacon). Gates `_authorizeUpgrade`. Held by the
    ///         timelocked multisig. Used by every upgradeable contract in the suite.
    bytes32 internal constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    /// @notice Guardian veto authority (veto a bad PnL report or a bad settlement). Independent of the
    ///         deployer and owner. Used by the asset vaults; declared here so the monitored role surface
    ///         is fixed from the first release.
    bytes32 internal constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice Bounded cross-chain PnL reporter. Isolated, KMS-custodied key whose ONLY capability is
    ///         to report the in-flight delta; it can never move share price beyond the per-epoch clamp
    ///         and can only make losses worse (settlement events are authoritative). Used by the vaults.
    bytes32 internal constant PNL_REPORTER_ROLE = keccak256("PNL_REPORTER_ROLE");

    /// @notice Sole authorized vault-puller: moves idle capital out to a venue and back, and adjusts
    ///         the vault's deployed-principal accounting. Held by the on-chain composer (wired in the
    ///         adapter phase); ungranted in the vault-scaffold phase so the custody seam is inert until
    ///         the composer exists.
    bytes32 internal constant COMPOSER_ROLE = keccak256("COMPOSER_ROLE");

    /// @notice Vault registration authority on `VaultRegistry`. Held by the `VaultFactory` so only the
    ///         factory can add a vault to the asset->vault allowlist adapters trust.
    bytes32 internal constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    /// @notice Composer submitter. Held by the operator EOA(s) that relay backend-signed capital ops to
    ///         the Composer. The signature is the authorization; this role bounds who may relay it.
    bytes32 internal constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Mid-swap net-settlement authority on a multi-class vault, held by a trader-driven venue
    ///         adapter (V4 hook, Aqua maker-hook, or a future venue) so it can pull/push a class's net
    ///         delta during a swap. Granted PER ADAPTER; each holder is one allow-listed address, so a
    ///         compromised adapter's blast radius is one adapter, not the venue category. Scoped and
    ///         distinct from `COMPOSER_ROLE`; bounded by the class's own idle and the rolling outflow meter.
    bytes32 internal constant VENUE_SETTLER_ROLE = keccak256("VENUE_SETTLER_ROLE");

    /// @notice Role-admin for capital-moving roles on `AssetVault` (`COMPOSER_ROLE`, `VENUE_SETTLER_ROLE`).
    /// @dev Granted to the same address as `DEFAULT_ADMIN_ROLE` at init, but as a SEPARATE role via
    ///      `_setRoleAdmin` - `DEFAULT_ADMIN_ROLE` alone can no longer `grantRole` a capital-moving role.
    ///      This is architectural separation of powers, not a
    ///      trust downgrade: both roles are timelock-held at deploy, but a future admin handoff that
    ///      rotates `DEFAULT_ADMIN_ROLE` without also rotating this role can no longer implicitly carry the
    ///      capital-granting capability along with it.
    bytes32 internal constant CAPITAL_ADMIN_ROLE = keccak256("CAPITAL_ADMIN_ROLE");
}
