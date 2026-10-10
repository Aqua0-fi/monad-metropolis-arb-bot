// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title IMakerHooks
/// @author Aqua0 Team
/// @notice The maker-side hook surface the 1inch SwapVM router invokes during a swap. Signatures mirror
///         `1inch/swap-vm/src/interfaces/IMakerHooks.sol` exactly; the selectors are consumed by deployed
///         bytecode, so they are a frozen wire format.
///
/// @dev CALL ORDER, established empirically against deployed bytecode in
///      `test/fork/SwapVMRouterPairing.fork.t.sol` (not from the 1inch source tree, which is a NEWER build
///      than either mainnet deployment):
///
///        _transferIn leg:   preTransferIn  -> [Aqua.push: tokenIn router->maker]  -> postTransferIn
///        _transferOut leg:  preTransferOut -> [Aqua.pull: tokenOut maker->taker]  -> postTransferOut
///
///      `swap()` runs the two legs in EITHER order. The taker chooses, via the `isFirstTransferFromTaker`
///      taker flag:
///        default (flag clear): _transferOut then _transferIn
///        flag set:             _transferIn then _transferOut
///      Any hook implementation must therefore be correct under both interleavings, and must never assume
///      that `postTransferIn` has run before `preTransferOut` (or vice versa).
///
///      Enabled per-hook by `MakerTraits` bits on the shipped order:
///        1<<252 preTransferIn · 1<<251 postTransferIn · 1<<250 preTransferOut · 1<<249 postTransferOut
///      Bits 1<<248..1<<245 redirect each hook to an explicit target; with all four clear the hook is called
///      on the MAKER itself, which is the only configuration Aqua0 ships.
///
///      ⚠️ SECURITY. Every function here is a PUBLIC ENTRY POINT on the maker. The router is the only
///      legitimate caller and an implementation MUST enforce that. `takerData` is supplied by the taker at
///      swap time and is entirely hostile; `makerData` is the slice of the maker's own order data.
interface IMakerHooks {
    /// @notice Called before `tokenIn` is transferred from the taker to the maker.
    function preTransferIn(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 orderHash,
        bytes calldata makerData,
        bytes calldata takerData
    ) external;

    /// @notice Called after `tokenIn` has been transferred from the taker to the maker.
    /// @dev With an Aqua order this fires AFTER `Aqua.push` has already deposited `amountIn` of `tokenIn`
    ///      into the maker's own ERC-20 balance. It is the maker's only opportunity to move that inflow on,
    ///      because Aqua forbids a custom `receiver`.
    function postTransferIn(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 orderHash,
        bytes calldata makerData,
        bytes calldata takerData
    ) external;

    /// @notice Called before `tokenOut` is transferred from the maker to the taker.
    /// @dev With an Aqua order this fires immediately BEFORE `Aqua.pull` executes
    ///      `tokenOut.transferFrom(maker, taker, amountOut)`. The maker therefore still has execution while
    ///      it is required to hold nothing: it may source `amountOut` here and satisfy the pull. This is the
    ///      seam that makes a non-custodial maker possible. A revert here reverts the entire swap.
    function preTransferOut(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 orderHash,
        bytes calldata makerData,
        bytes calldata takerData
    ) external;

    /// @notice Called after `tokenOut` has been transferred from the maker to the taker.
    function postTransferOut(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 orderHash,
        bytes calldata makerData,
        bytes calldata takerData
    ) external;
}
