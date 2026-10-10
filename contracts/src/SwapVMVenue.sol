// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface ISwapVMVenue {
    struct Order {
        address maker;
        uint256 traits;
        bytes data;
    }
    function AQUA() external view returns (address);
    function hash(Order calldata order) external view returns (bytes32);
    function swap(Order calldata order, address tokenIn, address tokenOut, uint256 amount, bytes calldata takerData)
        external
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);
}

interface IFleetAquaMaker {
    function aqua() external view returns (address);
    function aquaSwapVMRouter() external view returns (address);
    function currentAquaHash(bytes32 strategyId) external view returns (bytes32);
    function strategyClassId(bytes32 strategyId) external view returns (uint256);
    function getStrategyTokens(bytes32 strategyId) external view returns (address[] memory);
}

/// @dev A narrow venue seam. The enclosing executor owns the reentrancy guard, both swaps and
/// the final profit check. Operators cannot nominate arbitrary callees or custom taker callbacks.
abstract contract SwapVMVenue is Ownable2Step {
    using SafeERC20 for IERC20;

    struct SwapVMRouterApproval {
        address aqua;
        bytes32 codeHash;
        uint8 slices;
        bool allowed;
    }

    struct SwapVMStrategyApproval {
        address token0;
        address token1;
        uint256 classId;
        bool allowed;
    }
    mapping(address => SwapVMRouterApproval) public swapVMRouters;
    mapping(bytes32 => SwapVMStrategyApproval) public swapVMStrategies;
    error SwapVMRouteInvalid();
    error SwapVMFillMismatch();
    event SwapVMRouterSet(address indexed router, address aqua, uint8 slices, bool allowed);
    event SwapVMStrategySet(address indexed router, address indexed maker, bytes32 indexed strategyId, bool allowed);
    event SwapVMLegExecuted(
        address indexed router,
        address indexed maker,
        bytes32 indexed strategyId,
        bytes32 orderHash,
        uint256 classId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    function supportsAquaSwapVM() external pure returns (bool) {
        return true;
    }

    function swapVMStrategyKey(address router, address maker, bytes32 strategyId) public pure returns (bytes32) {
        return keccak256(abi.encode(router, maker, strategyId));
    }

    function setSwapVMRouter(address router, address aqua, uint8 slices, bool allowed) external onlyOwner {
        if (allowed) {
            if (
                router.code.length == 0 || aqua.code.length == 0 || (slices != 9 && slices != 10)
                    || ISwapVMVenue(router).AQUA() != aqua
            ) revert SwapVMRouteInvalid();
            swapVMRouters[router] = SwapVMRouterApproval(aqua, router.codehash, slices, true);
        } else {
            delete swapVMRouters[router];
        }
        emit SwapVMRouterSet(router, aqua, slices, allowed);
    }

    /// @notice Approve the fleet strategy's fixed pair/class. Reships may rotate the program,
    /// never this approval's class or pair. The current program is verified on every fill.
    function setSwapVMStrategy(address router, address maker, bytes32 strategyId, bool allowed) external onlyOwner {
        bytes32 key = swapVMStrategyKey(router, maker, strategyId);
        if (allowed) {
            SwapVMRouterApproval memory route = swapVMRouters[router];
            if (!route.allowed || maker.code.length == 0 || strategyId == bytes32(0)) revert SwapVMRouteInvalid();
            IFleetAquaMaker fleet = IFleetAquaMaker(maker);
            if (
                fleet.aqua() != route.aqua || fleet.aquaSwapVMRouter() != router
                    || fleet.currentAquaHash(strategyId) == bytes32(0)
            ) revert SwapVMRouteInvalid();
            address[] memory tokens = fleet.getStrategyTokens(strategyId);
            uint256 classId = fleet.strategyClassId(strategyId);
            if (
                tokens.length != 2 || tokens[0] == address(0) || tokens[1] == address(0) || tokens[0] == tokens[1]
                    || classId == 0
            ) revert SwapVMRouteInvalid();
            (address a, address b) = tokens[0] < tokens[1] ? (tokens[0], tokens[1]) : (tokens[1], tokens[0]);
            swapVMStrategies[key] = SwapVMStrategyApproval(a, b, classId, true);
        } else {
            delete swapVMStrategies[key];
        }
        emit SwapVMStrategySet(router, maker, strategyId, allowed);
    }

    function _executeSwapVM(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata payload,
        uint256 beforeOut
    ) internal {
        SwapVMRouterApproval memory route = swapVMRouters[router];
        if (!route.allowed || router.codehash != route.codeHash || payload.length > 32768) revert SwapVMRouteInvalid();
        (bytes32 strategyId, ISwapVMVenue.Order memory order) = abi.decode(payload, (bytes32, ISwapVMVenue.Order));
        SwapVMStrategyApproval memory approval = swapVMStrategies[swapVMStrategyKey(router, order.maker, strategyId)];
        IFleetAquaMaker maker = IFleetAquaMaker(order.maker);
        bytes32 orderHash = keccak256(abi.encode(order));
        bool pair = (tokenIn == approval.token0 && tokenOut == approval.token1)
            || (tokenIn == approval.token1 && tokenOut == approval.token0);
        if (
            !approval.allowed || !pair || (order.traits & (uint256(1) << 254)) == 0 || maker.aqua() != route.aqua
                || maker.aquaSwapVMRouter() != router || maker.strategyClassId(strategyId) != approval.classId
                || maker.currentAquaHash(strategyId) != orderHash || ISwapVMVenue(router).hash(order) != orderHash
        ) revert SwapVMRouteInvalid();
        // Only a positive output threshold is present. All reverse cumulative indexes are 32.
        // No recipient override or callbacks; the router pays this executor. Flag 0x0041 is
        // exact-input, transfer-from/Aqua-push, and transfer-out-first for the fleet hook latch.
        bytes memory takerData = new bytes(uint256(route.slices) * 2);
        for (uint256 i; i < route.slices; ++i) {
            takerData[2 * i + 1] = bytes1(uint8(32));
        }
        takerData = bytes.concat(takerData, hex"0041", abi.encode(minOut));
        IERC20(tokenIn).forceApprove(router, amountIn);
        (uint256 usedIn, uint256 out, bytes32 actualHash) =
            ISwapVMVenue(router).swap(order, tokenIn, tokenOut, amountIn, takerData);
        IERC20(tokenIn).forceApprove(router, 0);
        if (
            usedIn != amountIn || actualHash != orderHash || out < minOut
                || IERC20(tokenOut).balanceOf(address(this)) != beforeOut + out
        ) revert SwapVMFillMismatch();
        emit SwapVMLegExecuted(
            router, order.maker, strategyId, orderHash, approval.classId, tokenIn, tokenOut, usedIn, out
        );
    }
}
