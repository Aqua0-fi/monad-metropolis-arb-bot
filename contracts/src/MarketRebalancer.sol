// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
    function poolManager() external view returns (address);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @notice Prefunded, atomic two-leg rebalancing. An operator can only exchange allowlisted pairs;
/// owner controls custody, limits and venues. Profits stay in this contract until owner withdrawal.
/// @dev Standard ERC20s only. No bridges, flash loans, native currency, arbitrary calls or delegatecalls.
contract MarketRebalancer is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint160 private constant MIN_SQRT = 4295128740;
    uint160 private constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;
    bytes32 private constant AQUA0_MAGIC = keccak256("AQUA0_JIT_PAYLOAD");

    enum Venue {
        Aqua0V4,
        V3,
        UniswapV4
    }

    struct Leg {
        Venue venue;
        address target;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
        PoolKey pool;
        bytes hookData;
    }

    struct Trade {
        bytes32 id;
        uint256 deadline;
        uint256 validUntilBlock;
        uint256 minProfit;
        Leg first;
        Leg second;
    }

    struct Limit {
        uint256 maxInput;
        uint256 minProfit;
    }

    struct ExactInputSingle {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    struct ExtendedExactInputSingle {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    struct V3Approval {
        address token0;
        address token1;
        bool allowed;
    }

    address public immutable permit2;
    address public immutable universalRouter;
    address public immutable aqua0Hook;
    bool public immutable extendedV4Encoding;
    bool public paused = true;
    uint256 public maxGasPrice;
    /// @notice Dead-man switch: execute reverts after this timestamp. Zero (the default) means inactive,
    /// so a fresh deployment cannot trade until the owner opens a bounded window.
    uint64 public activeUntil;
    uint256 public constant MAX_ACTIVE_WINDOW = 1 days;
    mapping(address => bool) public operators;
    mapping(address => Limit) public limits;
    mapping(bytes32 => bool) public aquaPools;
    mapping(address => V3Approval) public v3Pools;
    /// @notice Owner-allowlisted external Uniswap V4 pools. Hookless only: an external hook could run
    /// arbitrary code inside our swap.
    mapping(bytes32 => bool) public v4Pools;
    mapping(bytes32 => bool) public used;
    address private callbackPool;
    address private callbackToken;
    uint256 private callbackRemaining;

    error GasPriceExceeded();
    error InvalidRoute();
    error Unauthorized();
    error Paused();
    error Expired();
    error Replayed();
    error LimitExceeded();
    error PartialFill();
    error InsufficientOutput();
    error Unprofitable();
    error BadCallback();
    error Inactive();
    event Executed(bytes32 indexed id, address indexed token, uint256 input, uint256 profit);
    event OperatorSet(address indexed operator, bool allowed);
    event LimitsSet(address indexed token, uint256 maxInput, uint256 minProfit);
    event PauseSet(bool paused);
    event GasPriceLimitSet(uint256 maxGasPrice);
    event AquaPoolSet(bytes32 indexed poolId, bool allowed);
    event V3PoolSet(address indexed pool, bool allowed);
    event V4PoolSet(bytes32 indexed poolId, bool allowed);
    event Withdrawn(address indexed token, address indexed recipient, uint256 amount);
    event ActiveUntilSet(uint64 activeUntil);

    constructor(address owner_, address router_, address permit2_, address hook_, bool extended_) Ownable(owner_) {
        if (router_.code.length == 0 || permit2_.code.length == 0 || hook_.code.length == 0) revert InvalidRoute();
        universalRouter = router_;
        permit2 = permit2_;
        aqua0Hook = hook_;
        extendedV4Encoding = extended_;
    }

    /// @notice EVM block.number differs from the RPC height on Arbitrum and Orbit chains.
    function executionBlockNumber() external view returns (uint256) {
        return block.number;
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert InvalidRoute();
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function setLimits(address token, uint256 maxInput, uint256 minProfit) external onlyOwner {
        if (token.code.length == 0 || minProfit == 0) revert InvalidRoute();
        limits[token] = Limit(maxInput, minProfit);
        emit LimitsSet(token, maxInput, minProfit);
    }

    function setGasPriceLimit(uint256 value) external onlyOwner {
        if (value == 0) revert InvalidRoute();
        maxGasPrice = value;
        emit GasPriceLimitSet(value);
    }

    function setPaused(bool value) external onlyOwner {
        if (!value && maxGasPrice == 0) revert GasPriceExceeded();
        paused = value;
        emit PauseSet(value);
    }

    /// @notice Open (or close, with any past value such as zero) the trading window. Bounded so a
    /// forgotten window always expires on its own.
    function setActiveUntil(uint64 value) external onlyOwner {
        if (value > block.timestamp + MAX_ACTIVE_WINDOW) revert LimitExceeded();
        activeUntil = value;
        emit ActiveUntilSet(value);
    }

    function setAquaPool(PoolKey calldata key, bool allowed) external onlyOwner {
        if (key.hooks != aqua0Hook || key.currency0 == address(0) || key.currency0 >= key.currency1) {
            revert InvalidRoute();
        }
        bytes32 id = keccak256(abi.encode(key));
        aquaPools[id] = allowed;
        emit AquaPoolSet(id, allowed);
    }

    function setV4Pool(PoolKey calldata key, bool allowed) external onlyOwner {
        if (
            key.hooks != address(0) || key.currency0 == address(0) || key.currency0 >= key.currency1
                || key.tickSpacing <= 0
        ) revert InvalidRoute();
        bytes32 id = keccak256(abi.encode(key));
        v4Pools[id] = allowed;
        emit V4PoolSet(id, allowed);
    }

    function setV3Pool(address pool, bool allowed) external onlyOwner {
        if (allowed) {
            address t0 = IV3Pool(pool).token0();
            address t1 = IV3Pool(pool).token1();
            if (t0 == address(0) || t0 >= t1) revert InvalidRoute();
            v3Pools[pool] = V3Approval(t0, t1, true);
        } else {
            delete v3Pools[pool];
        }
        emit V3PoolSet(pool, allowed);
    }

    function withdraw(address token, address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert InvalidRoute();
        IERC20(token).safeTransfer(recipient, amount);
        emit Withdrawn(token, recipient, amount);
    }

    function execute(Trade calldata trade) external nonReentrant returns (uint256 profit) {
        if (!operators[msg.sender]) revert Unauthorized();
        if (paused) revert Paused();
        if (block.timestamp > activeUntil) revert Inactive();
        if (tx.gasprice > maxGasPrice) revert GasPriceExceeded();
        if (
            block.timestamp > trade.deadline || block.number > trade.validUntilBlock
                || trade.deadline > block.timestamp + 120 || trade.validUntilBlock > block.number + 5
        ) revert Expired();
        if (used[trade.id]) revert Replayed();
        Leg calldata a = trade.first;
        Leg calldata b = trade.second;
        if (
            a.tokenIn == a.tokenOut || a.tokenIn != b.tokenOut || a.tokenOut != b.tokenIn
                || ((a.venue == Venue.Aqua0V4) == (b.venue == Venue.Aqua0V4)) || a.amountIn == 0 || b.amountIn == 0
                || a.minOut == 0 || b.minOut == 0
        ) revert InvalidRoute();
        Limit memory limit = limits[a.tokenIn];
        if (a.amountIn > limit.maxInput || trade.minProfit < limit.minProfit || trade.minProfit == 0) {
            revert LimitExceeded();
        }
        uint256 beforeBalance = IERC20(a.tokenIn).balanceOf(address(this));
        if (beforeBalance < a.amountIn) revert LimitExceeded();
        used[trade.id] = true;
        uint256 received = _swap(a, trade.deadline);
        // The second leg may only spend newly acquired inventory, never a pre-existing intermediate balance.
        if (b.amountIn > received) revert InsufficientOutput();
        _swap(b, trade.deadline);
        uint256 afterBalance = IERC20(a.tokenIn).balanceOf(address(this));
        if (afterBalance < beforeBalance + trade.minProfit) revert Unprofitable();
        profit = afterBalance - beforeBalance;
        emit Executed(trade.id, a.tokenIn, a.amountIn, profit);
    }

    function _swap(Leg calldata leg, uint256 deadline) private returns (uint256 received) {
        uint256 beforeIn = IERC20(leg.tokenIn).balanceOf(address(this));
        uint256 beforeOut = IERC20(leg.tokenOut).balanceOf(address(this));
        if (leg.venue == Venue.Aqua0V4) {
            PoolKey calldata key = leg.pool;
            if (
                leg.target != universalRouter || !aquaPools[keccak256(abi.encode(key))] || key.hooks != aqua0Hook
                    || !_pair(leg, key.currency0, key.currency1) || leg.amountIn > type(uint128).max
                    || leg.minOut > type(uint128).max || leg.hookData.length < 32
                    || bytes32(leg.hookData[:32]) != AQUA0_MAGIC
            ) revert InvalidRoute();
            _routerV4Swap(leg, deadline);
        } else if (leg.venue == Venue.UniswapV4) {
            PoolKey calldata key = leg.pool;
            if (
                leg.target != universalRouter || !v4Pools[keccak256(abi.encode(key))] || key.hooks != address(0)
                    || !_pair(leg, key.currency0, key.currency1) || leg.amountIn > type(uint128).max
                    || leg.minOut > type(uint128).max || leg.hookData.length != 0
            ) revert InvalidRoute();
            _routerV4Swap(leg, deadline);
        } else {
            V3Approval memory approved = v3Pools[leg.target];
            if (
                !approved.allowed || !_pair(leg, approved.token0, approved.token1)
                    || leg.amountIn > uint256(type(int256).max)
            ) revert InvalidRoute();
            bool zeroForOne = leg.tokenIn == approved.token0;
            callbackPool = leg.target;
            callbackToken = leg.tokenIn;
            callbackRemaining = leg.amountIn;
            IV3Pool(leg.target)
                .swap(address(this), zeroForOne, int256(leg.amountIn), zeroForOne ? MIN_SQRT : MAX_SQRT, bytes(""));
            callbackPool = address(0);
            callbackToken = address(0);
            callbackRemaining = 0;
        }
        uint256 afterIn = IERC20(leg.tokenIn).balanceOf(address(this));
        if (afterIn > beforeIn || beforeIn - afterIn != leg.amountIn) revert PartialFill();
        received = IERC20(leg.tokenOut).balanceOf(address(this)) - beforeOut;
        if (received < leg.minOut) revert InsufficientOutput();
    }

    /// @dev One exact-input V4 swap through the bound Universal Router, with an exact Permit2 grant that is
    /// revoked in the same call. Used for Aqua0's hook pools and for allowlisted hookless external pools.
    function _routerV4Swap(Leg calldata leg, uint256 deadline) private {
        PoolKey calldata key = leg.pool;
        IERC20(leg.tokenIn).forceApprove(permit2, leg.amountIn);
        IPermit2(permit2).approve(leg.tokenIn, universalRouter, uint160(leg.amountIn), uint48(deadline));
        bytes[] memory params = new bytes[](3);
        // Router deployments differ. Bind the tuple version at deployment, never guess from chain name.
        // amountOutMinimum and the executor balance floor remain mandatory in either version.
        params[0] = extendedV4Encoding
            ? abi.encode(
                ExtendedExactInputSingle(
                    key, leg.tokenIn == key.currency0, uint128(leg.amountIn), uint128(leg.minOut), 0, leg.hookData
                )
            )
            : abi.encode(
                ExactInputSingle(
                    key, leg.tokenIn == key.currency0, uint128(leg.amountIn), uint128(leg.minOut), leg.hookData
                )
            );
        params[1] = abi.encode(leg.tokenIn, leg.amountIn);
        params[2] = abi.encode(leg.tokenOut, leg.minOut);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"060c0f", params);
        IUniversalRouter(universalRouter).execute(hex"10", inputs, deadline);
        IPermit2(permit2).approve(leg.tokenIn, universalRouter, 0, 0);
        IERC20(leg.tokenIn).forceApprove(permit2, 0);
    }

    function _pair(Leg calldata leg, address a, address b) private pure returns (bool) {
        return (leg.tokenIn == a && leg.tokenOut == b) || (leg.tokenIn == b && leg.tokenOut == a);
    }

    function uniswapV3SwapCallback(int256 amount0, int256 amount1, bytes calldata) external {
        if (callbackPool == address(0) || msg.sender != callbackPool || (amount0 > 0) == (amount1 > 0)) {
            revert BadCallback();
        }
        V3Approval memory pool = v3Pools[msg.sender];
        if ((amount0 > 0 ? pool.token0 : pool.token1) != callbackToken) revert BadCallback();
        uint256 owed = uint256(amount0 > 0 ? amount0 : amount1);
        if (owed > callbackRemaining) revert BadCallback();
        callbackRemaining -= owed;
        IERC20(callbackToken).safeTransfer(msg.sender, owed);
    }
}
