// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title ISwapVMRouter
/// @author Aqua0 Team
/// @notice Interface for the deployed 1inch SwapVM router (quote/swap with Order).
/// @dev WHICH ROUTER IS BOUND IS RUNTIME DATA, NOT A CONSTANT IN THIS FILE. Resolve it from
///      `backend/deployments/{chainId}.json` -> `vaultFleet.external.swapVMRouter` (or through the
///      aqua0 registry package, which is generated from those files), never from an address written
///      into a comment. There is no router that is canonical "on every chain" by construction: a chain binds
///      what its deployment JSON says it binds, and that has already changed once.
///
///      As recorded there today: Base (8453), Arbitrum (42161), Avalanche (43114), Polygon (137) and
///      Robinhood (4663) all resolve to `0x111111338c5091E8440b67B168bAe16a668AC0De`, paired with the
///      1inch Aqua at `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`. That router reports
///      `eip712Domain()` name `1inch SwapVM v1.0` at version `1.0.2` (registry
///      `OFFICIAL_SWAPVM_ROUTER`). Celo (42220) and Monad (143) launch V4-first and bind the zero
///      address for both.
///
///      Two addresses this file used to assert, corrected [addr:unbound]: `0x8fDD04Dbf6111437B44bbca99C28882434e0958f`
///      self-reports `AquaSwapVMRouter` `1.0.0` and is bound by NO chain (registry
///      `AQUA_SWAPVM_ROUTER_V1_0_0`). `0x3c4758979eC30ca45857cAbC2462A70699ed790e` is not a scratch pad
///      that reverts every swap: it is a real v1.0 build that settles real swaps and fires the maker
///      hooks (`test/fork/RobinhoodSwapVM.fork.t.sol`), it carries a fork-proven opcode table, and it
///      was Robinhood's bound router until the cutover. What reverts is a MISMATCHED PAIR, a router
///      shipped into an Aqua it does not itself read; each router resolves balances against the Aqua it
///      binds, so assert `AQUA()` rather than treating any one router as poisoned.
///
///      For Aqua-backed orders: set `useAquaInsteadOfSignature` (bit 254) in `Order.traits`.
///      Order.data with no hooks = just the SwapVM program bytes.
///
///      MakerTraits hook bits, empirically pinned against deployed bytecode in
///      `test/fork/SwapVMRouterPairing.fork.t.sol`:
///        1<<252 preTransferIn · 1<<251 postTransferIn · 1<<250 preTransferOut · 1<<249 postTransferOut
///
///      ⚠️ `takerTraitsAndData` begins with a fixed-width traits header. THE WIDTH IS A PROPERTY OF THE
///      ROUTER BUILD, so there is no "canonical width" to target: read it from the resolved router.
///      Every chain bound today reads **22 bytes** (ten uint16 slice indexes plus a uint16 flag word),
///      discovered by execution in `test/fork/DeployedRouterOpcodeTable.fork.t.sol`. The unbound
///      `0x8fDD04...958f` build reads 20 (nine indexes), which is the same sliced-tail scheme with one
///      fewer index, not a different format. A wrong width does not revert, it misaligns the tail, so
///      it fails silently. This interface never builds taker data; anything that does must key the
///      width on the resolved router (backend `sliceCountForRouter` / the per-router
///      `takerHeaderBytes`), never on the EIP-712 name and never on a width copied from prose.
interface ISwapVMRouter {
    struct Order {
        address maker;
        uint256 traits; // MakerTraits: useAquaInsteadOfSignature = 1 << 254, receiver in low 160 bits
        bytes data; // For no hooks: the SwapVM program only
    }

    /// @notice The Aqua contract this router resolves balances against, and calls `pull`/`push` on.
    /// @dev IMMUTABLE on the router, set at its construction. The `app` passed to `Aqua.ship` must be this
    ///      router, and the Aqua shipped into must be THIS address. Assert it; do not assume it.
    function AQUA() external view returns (address);

    /// @notice Compute the hash of an order
    /// @dev For Aqua orders, hash = keccak256(abi.encode(order)); use same when shipping to Aqua.
    /// @param order The order to hash
    /// @return The order hash
    function hash(Order calldata order) external view returns (bytes32);

    /// @notice Quote the result of a swap without executing it
    /// @param order The maker order containing the SwapVM program
    /// @param tokenIn The input token address
    /// @param tokenOut The output token address
    /// @param amount The input amount
    /// @param takerTraitsAndData Taker traits and optional extra data
    /// @return amountIn The actual input amount
    /// @return amountOut The expected output amount
    /// @return orderHash The order hash
    function quote(
        Order calldata order,
        address tokenIn,
        address tokenOut,
        uint256 amount,
        bytes calldata takerTraitsAndData
    ) external view returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);

    /// @notice Execute a swap against a maker order
    /// @param order The maker order containing the SwapVM program
    /// @param tokenIn The input token address
    /// @param tokenOut The output token address
    /// @param amount The input amount
    /// @param takerTraitsAndData Taker traits and optional extra data
    /// @return amountIn The actual input amount consumed
    /// @return amountOut The output amount received
    /// @return orderHash The order hash
    function swap(
        Order calldata order,
        address tokenIn,
        address tokenOut,
        uint256 amount,
        bytes calldata takerTraitsAndData
    ) external returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);
}
