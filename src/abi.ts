import { parseAbi } from "viem";
export const poolTuple =
  "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
export const legTuple = `(uint8 venue,address target,address tokenIn,address tokenOut,uint256 amountIn,uint256 minOut,${poolTuple} pool,bytes hookData)`;
export const executorAbi = parseAbi([
  `function execute((bytes32 id,uint256 deadline,uint256 validUntilBlock,uint256 minProfit,${legTuple} first,${legTuple} second) trade) returns (uint256 profit)`,
  "function supportsAquaSwapVM() pure returns (bool)",
  "function swapVMRouters(address) view returns (address aqua,bytes32 codeHash,uint8 slices,bool allowed)",
  "function swapVMStrategyKey(address,address,bytes32) pure returns (bytes32)",
  "function swapVMStrategies(bytes32) view returns (address token0,address token1,uint256 classId,bool allowed)",
  "event SwapVMLegExecuted(address indexed router,address indexed maker,bytes32 indexed strategyId,bytes32 orderHash,uint256 classId,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut)",
  "function extendedV4Encoding() view returns (bool)",
  "function maxGasPrice() view returns (uint256)",
  "function executionBlockNumber() view returns (uint256)",
  "function paused() view returns (bool)",
  "function operators(address) view returns (bool)",
  "function universalRouter() view returns (address)",
  "function aqua0Hook() view returns (address)",
  "function permit2() view returns (address)",
  "function limits(address) view returns (uint256 maxInput,uint256 minProfit)",
  "function v3Pools(address) view returns (address token0,address token1,bool allowed)",
  "function aquaPools(bytes32) view returns (bool)",
  "event Executed(bytes32 indexed id,address indexed token,uint256 input,uint256 profit)",
]);
export const factoryAbi = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
]);
export const v3Abi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
]);
export const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
export const routerAbi = parseAbi([
  "function poolManager() view returns (address)",
]);
export const hookAbi = parseAbi([
  "function poolManager() view returns (address)",
  "function jitTriggerRouterAllowed(address) view returns (bool)",
]);
