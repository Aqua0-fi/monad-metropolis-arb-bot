// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title ICreateX
/// @author Aqua0 Team
/// @notice Minimal interface for CreateX's CREATE3 deployment functions
/// @dev CreateX is a third-party deterministic factory, not part of this fleet, so no deployment
///      record binds it. [addr:external] It is deployed at 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed on 150+ chains
interface ICreateX {
    /// @notice Deploy a contract using CREATE3 (address depends only on deployer + salt)
    /// @param salt The salt for deterministic address generation
    /// @param initCode The contract creation code (constructor + args)
    /// @return newContract The deployed contract address
    function deployCreate3(bytes32 salt, bytes memory initCode) external payable returns (address newContract);

    /// @notice Compute the CREATE3 address for a given salt and deployer
    /// @param salt The salt for deterministic address generation
    /// @param deployer The deployer address
    /// @return computedAddress The deterministic address
    function computeCreate3Address(bytes32 salt, address deployer) external view returns (address computedAddress);
}
