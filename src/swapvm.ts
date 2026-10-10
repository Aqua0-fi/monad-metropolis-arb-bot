import { z } from "zod";
import { randomBytes } from "node:crypto";
import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import {
  address,
  hex,
  positive,
  uint,
  same,
  zero,
  type ChainConfig,
} from "./config.js";
import { haircut, type Candidate, type Leg } from "./strategy.js";
import type { MarketPolicy } from "./market-catalog.js";
import type { ExternalPool } from "./venues.js";

const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((s) => s as Hex);
const orderAbi = parseAbiParameters(
  "(address maker,uint256 traits,bytes data)",
);
export const swapVMMarketSchema = z
  .object({
    venue: z.literal("aqua"),
    chainId: z.number().int().positive(),
    stableStrategyId: hash,
    classId: positive,
    currentAquaHash: hash,
    router: address,
    maker: address,
    aqua: address,
    slices: z.union([z.literal(9), z.literal(10)]),
    token0: address,
    token1: address,
    tokens: z
      .array(
        z.object({
          address,
          symbol: z.string().nullable(),
          decimals: z.number().int().min(0).max(36).nullable(),
        }),
      )
      .length(2),
    order: z.object({
      maker: address,
      traits: uint,
      data: hex.refine((s) => s.length <= 64002),
    }),
    blockNumber: uint,
    blockHash: hash,
    available: z.literal(true),
  })
  .refine(
    (m) =>
      BigInt(m.token0) > 0n &&
      BigInt(m.token0) < BigInt(m.token1) &&
      same(m.order.maker, m.maker) &&
      (m.order.traits & (1n << 254n)) !== 0n &&
      keccak256(encodeAbiParameters(orderAbi, [m.order])) ===
        m.currentAquaHash &&
      same(m.tokens[0]!.address, m.token0) &&
      same(m.tokens[1]!.address, m.token1),
    "SwapVM order/pair identity mismatch",
  );
export type SwapVMMarket = z.infer<typeof swapVMMarketSchema>;
export interface SwapVMExecutionContext {
  stableStrategyId: Hex;
  classId: bigint;
  currentAquaHash: Hex;
  router: Address;
  maker: Address;
  aqua: Address;
  slices: 9 | 10;
  order: { maker: Address; traits: bigint; data: Hex };
}
export function validateSwapVMListing(
  chain: ChainConfig,
  network: "mainnet" | "fork",
  raw: unknown,
) {
  const r = z
    .object({
      version: z.literal(1),
      venue: z.literal("aqua"),
      chainId: z.number().int(),
      network: z.enum(["mainnet", "fork"]),
      markets: z.array(swapVMMarketSchema).max(200),
      unavailable: z
        .array(
          z.object({ stableStrategyId: hash, reason: z.string().max(1000) }),
        )
        .max(200),
    })
    .parse(raw);
  if (
    r.chainId !== chain.chainId ||
    r.network !== network ||
    r.markets.some((m) => m.chainId !== chain.chainId)
  )
    throw new Error("SwapVM catalog network/chain mismatch");
  const binding = chain.swapVM;
  if (
    r.markets.length &&
    (!binding ||
      r.markets.some(
        (m) =>
          !same(m.router, binding.router) ||
          !same(m.maker, binding.maker) ||
          !same(m.aqua, binding.aqua) ||
          m.slices !== binding.slices,
      ))
  ) {
    throw new Error("SwapVM listing does not match the canonical deployment");
  }
  if (
    new Set(r.markets.map((m) => m.stableStrategyId.toLowerCase())).size !==
    r.markets.length
  )
    throw new Error("Duplicate SwapVM stable strategy");
  return r;
}
const optimizedSchema = z.object({
  version: z.literal(1),
  venue: z.literal("aqua"),
  network: z.enum(["mainnet", "fork"]),
  chainId: z.number().int(),
  market: swapVMMarketSchema,
  caller: address,
  baseToken: address,
  externalPool: address,
  externalFactory: address,
  externalFee: z.number().int().min(0).max(999999),
  maxInput: positive,
  minNetProfit: positive,
  gasBudget: uint,
  blockNumber: uint,
  blockHash: hash,
  blockTimestamp: uint,
  quoteKind: z.literal("actual-swapvm-and-native-v3"),
  transactionSimulated: z.literal(false),
  reservationsCreated: z.literal(false),
  candidates: z
    .array(
      z.object({
        aquaFirst: z.boolean(),
        amountIn: positive,
        firstAmountOut: positive,
        secondAmountIn: positive,
        finalAmountOut: positive,
        grossProfit: positive,
        netProfit: positive,
      }),
    )
    .max(2),
  searches: z
    .array(
      z.object({
        aquaFirst: z.boolean(),
        method: z.literal("opaque-vm-adaptive-multibracket"),
        evaluatedInputs: z.number().int().max(96),
        failedQuotes: z.number().int().nonnegative(),
        timedOut: z.boolean(),
        optimality: z.literal("best-actually-evaluated-size"),
      }),
    )
    .max(2),
});
export interface SwapVMSizingRequest {
  executionPriority?: boolean;
  signal?: AbortSignal | undefined;
  chain: ChainConfig;
  market: SwapVMMarket;
  policy: MarketPolicy;
  external: ExternalPool;
  network: "mainnet" | "fork";
  caller: Address;
  maxInput: bigint;
  gasBudget: bigint;
  slippageBps: number;
  fixedAmount?: bigint;
}
export function acceptSwapVMOptimization(
  raw: unknown,
  request: SwapVMSizingRequest,
  quotedAt: number,
) {
  const r = optimizedSchema.parse(raw),
    m = r.market,
    prior = request.market;
  if (
    m.chainId !== r.chainId ||
    m.blockNumber !== r.blockNumber ||
    !same(m.blockHash, r.blockHash) ||
    m.slices !== prior.slices
  )
    throw new Error("SwapVM sizing source block or router layout mismatch");
  if (
    r.chainId !== request.chain.chainId ||
    r.network !== request.network ||
    !same(m.stableStrategyId, prior.stableStrategyId) ||
    m.classId !== BigInt(request.policy.classId) ||
    !same(m.router, prior.router) ||
    !same(m.aqua, prior.aqua) ||
    !same(m.maker, prior.maker) ||
    !same(m.token0, prior.token0) ||
    !same(m.token1, prior.token1) ||
    !same(r.caller, request.caller) ||
    !same(r.baseToken, request.policy.baseToken) ||
    !same(r.externalPool, request.external.address) ||
    !same(r.externalFactory, request.external.venue.factory) ||
    r.externalFee !== request.external.fee ||
    r.maxInput !== request.maxInput ||
    r.maxInput > BigInt(request.policy.maxInput) ||
    r.gasBudget !== request.gasBudget ||
    r.minNetProfit !== BigInt(request.policy.minNetProfit)
  )
    throw new Error(
      "SwapVM sizing response changed an approved identity or risk bound",
    );
  const context: SwapVMExecutionContext = {
    stableStrategyId: m.stableStrategyId,
    classId: m.classId,
    currentAquaHash: m.currentAquaHash,
    router: m.router,
    maker: m.maker,
    aqua: m.aqua,
    slices: m.slices,
    order: m.order,
  };
  const payload = encodeAbiParameters(
    parseAbiParameters("bytes32,(address maker,uint256 traits,bytes data)"),
    [context.stableStrategyId, context.order],
  );
  if ((payload.length - 2) / 2 > 32768)
    throw new Error("SwapVM execution payload exceeds the executor bound");
  if (
    new Set(r.candidates.map((q) => q.aquaFirst)).size !== r.candidates.length
  )
    throw new Error("Duplicate SwapVM direction");
  const base = request.policy.baseToken as Address,
    other = same(base, m.token0) ? m.token1 : m.token0;
  const reserved = {
    currency0: zero,
    currency1: zero,
    fee: 0,
    tickSpacing: 0,
    hooks: zero,
  };
  const candidates: Candidate[] = r.candidates.map((q) => {
    if (
      q.amountIn > request.maxInput ||
      (request.fixedAmount !== undefined &&
        q.amountIn !== request.fixedAmount) ||
      q.secondAmountIn !== haircut(q.firstAmountOut, request.slippageBps) ||
      q.grossProfit !== q.finalAmountOut - q.amountIn ||
      q.netProfit !== q.grossProfit - request.gasBudget ||
      q.netProfit < BigInt(request.policy.minNetProfit)
    )
      throw new Error(
        "SwapVM result does not satisfy the approved profit/capital bounds",
      );
    const leg = (
      aqua: boolean,
      input: Address,
      output: Address,
      amount: bigint,
      minOut: bigint,
    ): Leg => ({
      venue: aqua ? 2 : 1,
      target: aqua ? m.router : request.external.address,
      tokenIn: input,
      tokenOut: output,
      amountIn: amount,
      minOut,
      pool: reserved,
      hookData: aqua ? payload : "0x",
    });
    return {
      quotedAt,
      blockNumber: r.blockNumber,
      quoteBlockHash: r.blockHash,
      quotedProfit: q.grossProfit,
      netProfit: q.netProfit,
      minimumNetProfit: BigInt(request.policy.minNetProfit),
      aquaFirst: q.aquaFirst,
      swapVM: context,
      trade: {
        id: `0x${randomBytes(32).toString("hex")}`,
        deadline: r.blockTimestamp + 60n,
        validUntilBlock: r.blockNumber + 2n,
        minProfit: request.gasBudget + BigInt(request.policy.minNetProfit),
        first: leg(q.aquaFirst, base, other, q.amountIn, q.secondAmountIn),
        second: leg(
          !q.aquaFirst,
          other,
          base,
          q.secondAmountIn,
          q.finalAmountOut,
        ),
      },
    };
  });
  return { candidates, searches: r.searches };
}
