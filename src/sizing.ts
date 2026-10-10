import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  address,
  positive,
  uint,
  same,
  type ChainConfig,
  type Market,
  type Pool,
} from "./config.js";
import { haircut, type Candidate, type Leg } from "./strategy.js";
import type { ExternalPool } from "./venues.js";

const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((s) => s as `0x${string}`);
const responseSchema = z.object({
  version: z.literal(1),
  venue: z.literal("v4"),
  network: z.enum(["mainnet", "fork"]),
  chainId: z.number().int().positive(),
  poolId: hash,
  classId: positive,
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
  transactionSimulated: z.literal(false),
  reservationsCreated: z.literal(false),
  quoteKind: z.literal("native-standard-v4-jit-projection-and-v3"),
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
        method: z.literal("concentrated-liquidity-marginal-bracket"),
        aquaFirst: z.boolean(),
        evaluatedInputs: z.number().int().min(0).max(768),
        curveEvaluations: z.number().int().min(0).max(1600),
        sizingMs: z.number().nonnegative(),
      }),
    )
    .max(2),
  excluded: z
    .array(z.object({ aquaFirst: z.boolean(), reason: z.string().max(5000) }))
    .max(2),
});
export interface SizingRequest {
  executionPriority?: boolean;
  signal?: AbortSignal | undefined;
  chain: ChainConfig;
  pool: Pool;
  market: Market;
  external: ExternalPool;
  network: "mainnet" | "fork";
  maxInput: bigint;
  gasBudget: bigint;
  slippageBps: number;
  quotedAt: number;
}

/** Validate the backend's proposed size; never turn an unchecked response into signed calldata. */
export function acceptOptimizedCandidates(
  raw: unknown,
  request: SizingRequest,
) {
  const result = responseSchema.parse(raw);
  const { chain, pool, market, external } = request;
  if (
    result.chainId !== chain.chainId ||
    result.network !== request.network ||
    !same(result.poolId, pool.poolId) ||
    result.classId !== market.classId ||
    !same(result.baseToken, market.baseToken) ||
    !same(result.externalPool, external.address) ||
    !same(result.externalFactory, external.venue.factory) ||
    result.externalFee !== external.fee ||
    result.maxInput !== request.maxInput ||
    result.maxInput > market.maxInput ||
    result.gasBudget !== request.gasBudget ||
    result.minNetProfit !== market.minNetProfit
  ) {
    throw new Error(
      "Automatic sizing response does not match the approved market and risk limits",
    );
  }
  if (
    new Set(result.candidates.map((c) => c.aquaFirst)).size !==
    result.candidates.length
  )
    throw new Error("Duplicate optimized direction");
  const { poolId: _, ...key } = pool;
  const other = same(market.baseToken, pool.currency0)
    ? pool.currency1
    : pool.currency0;
  const candidates: Candidate[] = result.candidates.map((q) => {
    if (
      q.amountIn > request.maxInput ||
      q.secondAmountIn !== haircut(q.firstAmountOut, request.slippageBps) ||
      q.grossProfit !== q.finalAmountOut - q.amountIn ||
      q.netProfit !== q.grossProfit - request.gasBudget ||
      q.netProfit < market.minNetProfit
    )
      throw new Error(
        "Optimized amounts do not satisfy the profit and capital constraints",
      );
    const leg = (
      aqua: boolean,
      input: typeof market.baseToken,
      output: typeof market.baseToken,
      amount: bigint,
      minOut: bigint,
    ): Leg => ({
      venue: aqua ? 0 : 1,
      target: aqua ? chain.universalRouter : external.address,
      tokenIn: input,
      tokenOut: output,
      amountIn: amount,
      minOut,
      pool: key,
      hookData: "0x",
    });
    return {
      quotedAt: request.quotedAt,
      blockNumber: result.blockNumber,
      quoteBlockHash: result.blockHash,
      quotedProfit: q.grossProfit,
      netProfit: q.netProfit,
      minimumNetProfit: market.minNetProfit,
      aquaFirst: q.aquaFirst,
      trade: {
        id: `0x${randomBytes(32).toString("hex")}`,
        deadline: result.blockTimestamp + 60n,
        validUntilBlock: result.blockNumber + 2n,
        minProfit: request.gasBudget + market.minNetProfit,
        first: leg(
          q.aquaFirst,
          market.baseToken,
          other,
          q.amountIn,
          q.secondAmountIn,
        ),
        second: leg(
          !q.aquaFirst,
          other,
          market.baseToken,
          q.secondAmountIn,
          q.finalAmountOut,
        ),
      },
    };
  });
  return {
    candidates,
    searches: result.searches,
    excluded: result.excluded,
    blockNumber: result.blockNumber,
  };
}
