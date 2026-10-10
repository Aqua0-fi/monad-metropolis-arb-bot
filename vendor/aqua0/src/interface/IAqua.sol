// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title IAqua
/// @author Aqua0 Team
/// @notice Interface for 1inch Aqua protocol (shared liquidity layer)
/// @dev This interface represents the subset of Aqua functionality used by Aqua0, plus
///      pull() and push() which are called by the SwapVM router during swap execution
///      (not by Aqua0 directly). They are documented here for parity with aqua-protocol.
///      WHICH Aqua is bound is runtime data: read `vaultFleet.external.aqua` from
///      `backend/deployments/{chainId}.json`, never an address written into a comment. As recorded
///      there today, all five Aqua chains bind 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a. This line
///      previously named [addr:superseded] 0x499943E74FB0cE105688beeE8Ef2ABec5D936d31 as "the actual
///      Aqua contract"; that is the pre-cutover Aqua and no chain binds it now.
///
///      Key Aqua concepts:
///      - Virtual balances: _balances[maker][app][strategyHash][token]
///        - maker: msg.sender when calling ship(); in Aqua0, the SwapVMAdapter address
///        - app: First parameter to ship(); the SwapVM router address
///        - strategyHash: keccak256(strategy); hash of the raw strategy bytes
///        - token: The token address
///
///      - Strategies are SwapVM bytecode programs, NOT separate contracts
///      - ship() creates virtual balance entries (maker = msg.sender, app = first param)
///      - dock() zeros virtual balance entries (maker = msg.sender, app = first param)
///      - pull() is called by the SwapVM router to transfer tokenOut from the maker to the taker
///      - push() is called by the SwapVM router to transfer tokenIn from the router to the maker
///
///      This interface covers the full settlement surface of Aqua as relevant to Aqua0.
interface IAqua {
    /// @notice Returns the raw balance for a specific maker, app, strategy, and token
    /// @param maker The maker address (LP Smart Account)
    /// @param app The app address that manages the strategy
    /// @param strategyHash The strategy hash (keccak256 of raw strategy bytes)
    /// @param token The token address
    /// @return balance The current balance amount
    /// @return tokensCount The number of tokens in the strategy (0xff = docked)
    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external
        view
        returns (uint248 balance, uint8 tokensCount);

    /// @notice Returns balances of two tokens in a strategy, reverts if any token is not active
    /// @param maker The maker address (LP Smart Account)
    /// @param app The app address that manages the strategy
    /// @param strategyHash The strategy hash
    /// @param token0 The first token address
    /// @param token1 The second token address
    /// @return balance0 The balance for the first token
    /// @return balance1 The balance for the second token
    function safeBalances(address maker, address app, bytes32 strategyHash, address token0, address token1)
        external
        view
        returns (uint256 balance0, uint256 balance1);

    /// @notice Ship a new strategy and set initial balances
    /// @dev Creates virtual balance entries in Aqua's registry.
    ///      The caller (msg.sender) becomes the "maker" in the 4D mapping.
    ///      strategyHash = keccak256(strategy)
    ///      Emits Shipped(maker, app, strategyHash, strategy)
    /// @param app The app/implementation contract address
    /// @param strategy The strategy bytes (SwapVM bytecode program)
    /// @param tokens The tokens to allocate
    /// @param amounts The amounts to allocate for each token
    /// @return strategyHash The strategy hash (keccak256 of strategy bytes)
    function ship(address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts)
        external
        returns (bytes32 strategyHash);

    /// @notice Dock (deactivate) a strategy by clearing balances for specified tokens
    /// @dev Sets balances to 0 for all specified tokens, marks them as docked.
    ///      The caller (msg.sender) is the maker.
    ///      Emits Docked(maker, app, strategyHash)
    /// @param app The app address associated with the strategy
    /// @param strategyHash The strategy hash to dock
    /// @param tokens Array of token addresses to clear (must include all strategy tokens)
    function dock(address app, bytes32 strategyHash, address[] memory tokens) external;

    /// @notice Pull tokens from a strategy's maker on behalf of a swap (called by SwapVM router).
    /// @dev Decrements `_balances[maker][msg.sender][strategyHash][token]` and executes
    ///      `IERC20(token).safeTransferFrom(maker, to, amount)`. The maker must have approved
    ///      the Aqua contract for at least `amount` of `token`. In Aqua0, the maker is the
    ///      SwapVMAdapter; approval is granted by `shipStrategy` / `reshipStrategy` via
    ///      `IERC20.forceApprove(address(aqua), received)` before calling `aqua.ship`.
    /// @param maker The maker of the strategy (in Aqua0, the SwapVMAdapter address).
    /// @param strategyHash The current Aqua hash of the strategy.
    /// @param token Token to pull from the maker.
    /// @param amount Amount to pull.
    /// @param to Recipient (typically the swap taker).
    function pull(address maker, bytes32 strategyHash, address token, uint256 amount, address to) external;

    /// @notice Push tokens into a strategy's maker on behalf of a swap (called by SwapVM router).
    /// @dev Increments `_balances[maker][app][strategyHash][token]` and executes
    ///      `IERC20(token).safeTransferFrom(msg.sender, maker, amount)`. The router (msg.sender)
    ///      must have already received the inbound tokens from the swap taker and must have
    ///      approved Aqua to pull them. In Aqua0, the maker is the SwapVMAdapter; Aqua.push
    ///      deposits tokenIn directly into the adapter's ERC20 balance, which is why
    ///      dockStrategy and reshipStrategy sweep the adapter's balance back to the vault.
    /// @param maker The maker of the strategy (in Aqua0, the SwapVMAdapter address).
    /// @param app The app address (the SwapVM router address).
    /// @param strategyHash The current Aqua hash of the strategy.
    /// @param token Token to push into the maker.
    /// @param amount Amount to push.
    function push(address maker, address app, bytes32 strategyHash, address token, uint256 amount) external;
}
