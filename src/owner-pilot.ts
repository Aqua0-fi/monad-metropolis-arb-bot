import { z } from "zod";
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  parseAbi,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { address, positive, same, type ChainConfig } from "./config.js";
import { normalizeRuntime, type RuntimeArtifact } from "./owner-deployment.js";
import { ceilDiv } from "./strategy.js";

export const pilotPolicySchema = z
  .object({
    chainId: z.literal(42161),
    owner: address,
    executor: address,
    baseToken: address,
    wrappedNative: address,
    strategyId: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .transform((v) => v as Hex),
    maker: address,
    swapVMRouter: address,
    aqua: address,
    slices: z.union([z.literal(9), z.literal(10)]),
    classId: positive,
    externalPool: address,
    externalFactory: address,
    externalQuoter: address,
    fundingRouter: address,
    inventoryTarget: positive,
    maxInput: positive,
    minNetProfit: positive,
    maxGasUnits: positive,
    maxFeePerGas: positive,
    maxDailyGasWei: positive,
    maxFundingEthWei: positive,
    maxSetupFeeWei: positive,
    feeBufferBps: z.literal(10500),
    fundingSlippageBps: z.number().int().min(0).max(100),
    note: z.string(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (
      p.inventoryTarget > 5_000_000n ||
      p.maxInput > 5_000_000n ||
      p.maxInput > p.inventoryTarget ||
      p.maxFundingEthWei > 3_000_000_000_000_000n ||
      p.maxSetupFeeWei > 300_000_000_000_000n ||
      p.maxDailyGasWei > 300_000_000_000_000n ||
      p.maxGasUnits > 2_000_000n ||
      p.maxFeePerGas > 50_000_000n
    )
      ctx.addIssue({
        code: "custom",
        message: "Owner pilot exceeds its reviewed small-capital limits",
      });
    if (same(p.owner, p.executor) || same(p.baseToken, p.wrappedNative))
      ctx.addIssue({
        code: "custom",
        message: "Pilot account and asset roles must remain distinct",
      });
  });
export type PilotPolicy = z.infer<typeof pilotPolicySchema>;
export const ownerSetupAbi = parseAbi([
  "function setOperator(address,bool)",
  "function setLimits(address,uint256,uint256)",
  "function setGasPriceLimit(uint256)",
  "function setV3Pool(address,bool)",
  "function setSwapVMRouter(address,address,uint8,bool)",
  "function setSwapVMStrategy(address,address,bytes32,bool)",
  "function setPaused(bool)",
]);
export const fundingAbi = parseAbi([
  "function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) payable returns(uint256 amountIn)",
  "function refundETH() payable",
  "function multicall(uint256 deadline,bytes[] data) payable returns(bytes[])",
]);
const identityAbi = parseAbi([
  "function factory() view returns(address)",
  "function factoryV3() view returns(address)",
  "function WETH9() view returns(address)",
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function fee() view returns(uint24)",
  "function AQUA() view returns(address)",
  "function aqua() view returns(address)",
  "function aquaSwapVMRouter() view returns(address)",
  "function strategyClassId(bytes32) view returns(uint256)",
  "function currentAquaHash(bytes32) view returns(bytes32)",
  "function getStrategyTokens(bytes32) view returns(address[])",
]);
const quoterAbi = parseAbi([
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)",
]);
export interface OwnerStep {
  id: string;
  description: string;
  to: Address;
  data: Hex;
  value: bigint;
  deadline?: bigint;
}
export interface PilotState {
  blockNumber: bigint;
  blockHash: Hex;
  timestamp: bigint;
  paused: boolean;
  operator: boolean;
  maxInput: bigint;
  minimumGrossProfit: bigint;
  gasPriceCap: bigint;
  poolAllowed: boolean;
  routerAllowed: boolean;
  strategyAllowed: boolean;
  inventory: bigint;
  ownerEth: bigint;
  externalFee: number;
  currentOrder: Hex;
  executorCodeHash: Hex;
  makerCodeHash: Hex;
}

/** The policy selects identities; every critical deployment binding is verified on the actual chain. */
export async function readPilotState(
  client: PublicClient,
  p: PilotPolicy,
  chain: ChainConfig,
  artifact: { abi: Abi; deployedBytecode: RuntimeArtifact },
): Promise<PilotState> {
  if (
    (await client.getChainId()) !== 42161 ||
    chain.chainId !== 42161 ||
    !chain.nativeEquivalent ||
    !same(chain.nativeEquivalent.token, p.wrappedNative) ||
    chain.nativeEquivalent.decimals !== 18
  )
    throw Error("Arbitrum chain/native asset identity mismatch");
  const b = await client.getBlock();
  const read = (
    target: Address,
    name: string,
    args: readonly unknown[] = [],
    abi: Abi = identityAbi,
  ) =>
    client.readContract({
      address: target,
      abi,
      functionName: name,
      args,
      blockNumber: b.number,
    }) as Promise<any>;
  const own = (name: string, args: readonly unknown[] = []) =>
    read(p.executor, name, args, artifact.abi);
  const [
    code,
    makerCode,
    owner,
    paused,
    operator,
    limits,
    cap,
    router,
    permit2,
    hook,
    extended,
    pair0,
    pair1,
    factory,
    fee,
    quoteFactory,
    fundFactory,
    wrapped,
    vmAqua,
    makerAqua,
    makerRouter,
    classId,
    order,
    tokens,
    usdcDecimals,
    wethDecimals,
    inventory,
    ownerEth,
  ] = await Promise.all([
    client.getCode({ address: p.executor, blockNumber: b.number }),
    client.getCode({ address: p.maker, blockNumber: b.number }),
    own("owner"),
    own("paused"),
    own("operators", [p.owner]),
    own("limits", [p.baseToken]),
    own("maxGasPrice"),
    own("universalRouter"),
    own("permit2"),
    own("aqua0Hook"),
    own("extendedV4Encoding"),
    read(p.externalPool, "token0"),
    read(p.externalPool, "token1"),
    read(p.externalPool, "factory"),
    read(p.externalPool, "fee"),
    read(p.externalQuoter, "factory"),
    read(p.fundingRouter, "factory"),
    read(p.fundingRouter, "WETH9"),
    read(p.swapVMRouter, "AQUA"),
    read(p.maker, "aqua"),
    read(p.maker, "aquaSwapVMRouter"),
    read(p.maker, "strategyClassId", [p.strategyId]),
    read(p.maker, "currentAquaHash", [p.strategyId]),
    read(p.maker, "getStrategyTokens", [p.strategyId]),
    read(p.baseToken, "decimals", [], erc20Abi),
    read(p.wrappedNative, "decimals", [], erc20Abi),
    read(p.baseToken, "balanceOf", [p.executor], erc20Abi),
    client.getBalance({ address: p.owner, blockNumber: b.number }),
  ]);
  if (
    !code ||
    !makerCode ||
    normalizeRuntime(code, artifact.deployedBytecode) !==
      normalizeRuntime(
        artifact.deployedBytecode.object,
        artifact.deployedBytecode,
      )
  )
    throw Error("Executor runtime differs from the tested compiler artifact");
  if (
    !same(owner, p.owner) ||
    !same(router, chain.universalRouter) ||
    !same(permit2, chain.permit2) ||
    !same(hook, chain.aqua0Hook) ||
    extended !== chain.extendedV4Encoding
  )
    throw Error(
      "Executor owner or immutable bindings differ from the reviewed deployment",
    );
  if (
    !same(factory, p.externalFactory) ||
    !same(quoteFactory, p.externalFactory) ||
    !same(fundFactory, p.externalFactory) ||
    !same(wrapped, p.wrappedNative) ||
    !chain.venues.some(
      (v) =>
        same(v.factory, factory) &&
        same(v.quoter, p.externalQuoter) &&
        v.fees.includes(fee),
    )
  )
    throw Error(
      "External execution, funding or quoting venue identity mismatch",
    );
  if (
    same(pair0, pair1) ||
    ![pair0, pair1].some((t) => same(t, p.baseToken)) ||
    ![pair0, pair1].some((t) => same(t, p.wrappedNative)) ||
    usdcDecimals !== 6 ||
    wethDecimals !== 18
  )
    throw Error("Onchain pair or decimal identity mismatch");
  if (
    !same(vmAqua, p.aqua) ||
    !same(makerAqua, p.aqua) ||
    !same(makerRouter, p.swapVMRouter) ||
    classId !== p.classId ||
    order === zeroHash ||
    tokens.length !== 2 ||
    !tokens.some((t: Address) => same(t, p.baseToken)) ||
    !tokens.some((t: Address) => same(t, p.wrappedNative))
  )
    throw Error(
      "The current production maker no longer matches the reviewed pair/class/router",
    );
  const key = await own("swapVMStrategyKey", [
    p.swapVMRouter,
    p.maker,
    p.strategyId,
  ]);
  const [poolApproval, routerApproval, strategyApproval, vmCode] =
    await Promise.all([
      own("v3Pools", [p.externalPool]),
      own("swapVMRouters", [p.swapVMRouter]),
      own("swapVMStrategies", [key]),
      client.getCode({ address: p.swapVMRouter, blockNumber: b.number }),
    ]);
  if (!vmCode || vmCode === "0x") throw Error("SwapVM router code unavailable");
  // An enabled but incompatible approval is never silently repaired or widened.
  const poolAllowed = Boolean(poolApproval[2]);
  const routerAllowed = Boolean(routerApproval[3]);
  const strategyAllowed = Boolean(strategyApproval[3]);
  if (
    poolAllowed &&
    (!same(poolApproval[0], pair0) || !same(poolApproval[1], pair1))
  )
    throw Error("Existing external approval differs");
  if (
    routerAllowed &&
    (!same(routerApproval[0], p.aqua) ||
      routerApproval[1] !== keccak256(vmCode) ||
      routerApproval[2] !== p.slices)
  )
    throw Error("Existing router approval differs");
  if (
    strategyAllowed &&
    (!same(strategyApproval[0], pair0) ||
      !same(strategyApproval[1], pair1) ||
      strategyApproval[2] !== p.classId)
  )
    throw Error("Existing strategy approval differs");
  if ((await client.getBlock({ blockNumber: b.number })).hash !== b.hash)
    throw Error("Pilot preflight block reorganized");
  return {
    blockNumber: b.number,
    blockHash: b.hash,
    timestamp: b.timestamp,
    paused,
    operator,
    maxInput: limits[0],
    minimumGrossProfit: limits[1],
    gasPriceCap: cap,
    poolAllowed,
    routerAllowed,
    strategyAllowed,
    inventory,
    ownerEth,
    externalFee: fee,
    currentOrder: order,
    executorCodeHash: keccak256(code),
    makerCodeHash: keccak256(makerCode),
  };
}

export function setupSteps(p: PilotPolicy, s: PilotState): OwnerStep[] {
  const out: OwnerStep[] = [];
  const add = (
    id: string,
    description: string,
    functionName: string,
    args: readonly unknown[],
  ) =>
    out.push({
      id,
      description,
      to: p.executor,
      data: encodeFunctionData({
        abi: ownerSetupAbi as Abi,
        functionName,
        args,
      }),
      value: 0n,
    });
  if (!s.operator)
    add(
      "operator",
      "Allow the existing owner wallet as the pilot operator",
      "setOperator",
      [p.owner, true],
    );
  if (s.maxInput !== p.maxInput || s.minimumGrossProfit !== p.minNetProfit)
    add(
      "limits",
      "Limit each trade to 5 native USDC with a positive profit floor",
      "setLimits",
      [p.baseToken, p.maxInput, p.minNetProfit],
    );
  if (s.gasPriceCap !== p.maxFeePerGas)
    add(
      "gas-cap",
      "Set the explicit gas-price ceiling, not an assumed fee",
      "setGasPriceLimit",
      [p.maxFeePerGas],
    );
  if (!s.poolAllowed)
    add(
      "external-pool",
      "Approve only the reviewed external V3 pool",
      "setV3Pool",
      [p.externalPool, true],
    );
  if (!s.routerAllowed)
    add(
      "swapvm-router",
      "Bind the real SwapVM router, Aqua and header width",
      "setSwapVMRouter",
      [p.swapVMRouter, p.aqua, p.slices, true],
    );
  if (!s.strategyAllowed)
    add(
      "swapvm-strategy",
      "Approve only the reviewed stable Aqua strategy and pair/class",
      "setSwapVMStrategy",
      [p.swapVMRouter, p.maker, p.strategyId, true],
    );
  return out;
}
export async function fundingStep(
  client: PublicClient,
  p: PilotPolicy,
  s: PilotState,
): Promise<OwnerStep | null> {
  if (s.inventory >= p.inventoryTarget) return null;
  const amount = p.inventoryTarget - s.inventory;
  const { result } = await client.simulateContract({
    address: p.externalQuoter,
    abi: quoterAbi,
    functionName: "quoteExactOutputSingle",
    args: [
      {
        tokenIn: p.wrappedNative,
        tokenOut: p.baseToken,
        amount,
        fee: s.externalFee,
        sqrtPriceLimitX96: 0n,
      },
    ],
    blockNumber: s.blockNumber,
  });
  if (result[0] <= 0n) throw Error("Funding quote is unavailable");
  const value = ceilDiv(
    result[0] * BigInt(10000 + p.fundingSlippageBps),
    10000n,
  );
  if (value > p.maxFundingEthWei || value + p.maxSetupFeeWei >= s.ownerEth)
    throw Error(
      "Funding or retained gas balance would exceed the reviewed budget",
    );
  const deadline = s.timestamp + 180n;
  const calls = [
    encodeFunctionData({
      abi: fundingAbi,
      functionName: "exactOutputSingle",
      args: [
        {
          tokenIn: p.wrappedNative,
          tokenOut: p.baseToken,
          fee: s.externalFee,
          recipient: p.executor,
          amountOut: amount,
          amountInMaximum: value,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
    encodeFunctionData({ abi: fundingAbi, functionName: "refundETH" }),
  ];
  return {
    id: "fund-usdc",
    description:
      "Buy only the missing pilot USDC into the executor; refund unused ETH to owner",
    to: p.fundingRouter,
    value,
    data: encodeFunctionData({
      abi: fundingAbi,
      functionName: "multicall",
      args: [deadline, calls],
    }),
    deadline,
  };
}
export function unpauseStep(p: PilotPolicy): OwnerStep {
  return {
    id: "unpause",
    description:
      "Unpause the capped executor after verifying its setup and inventory",
    to: p.executor,
    value: 0n,
    data: encodeFunctionData({
      abi: ownerSetupAbi,
      functionName: "setPaused",
      args: [false],
    }),
  };
}
export function pilotExecutionConfig(
  p: PilotPolicy,
  kms: { region: string; keyId: string },
  fee: number,
) {
  return {
    executor: p.executor,
    operator: p.owner,
    kms,
    allowBroadcast: false,
    externalPools: [p.externalPool],
    maxGasUnits: String(p.maxGasUnits),
    liveFeeBufferBps: p.feeBufferBps,
    maxFeePerGas: String(p.maxFeePerGas),
    l1FeeReserveWei: "0",
    maxDailyGasWei: String(p.maxDailyGasWei),
    wrappedNative: p.wrappedNative,
    gasConversionFee: fee,
    gasCostBufferBps: p.feeBufferBps,
  };
}
