// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title IFillerRegistry
/// @author Aqua0 Team
/// @notice Read surface of the self-service LP participation registry.
/// @dev OPT-IN, read literally: `false` - including the default for an LP who has never called
///      `setParticipation` - means NOT participating. The registry's own NatSpec once described the inverse,
///      an opt-OUT model in which an absent row meant participating; that reading is wrong for the way the
///      flag is now used and would make every depositor frontable by default, having consented to nothing.
///      Consumers must fail closed: treat a read error as not participating.
interface IFillerRegistry {
    /// @notice Whether `lp` has explicitly opted in to JIT routing and cross-chain fronting.
    function isParticipating(address lp) external view returns (bool);
}
