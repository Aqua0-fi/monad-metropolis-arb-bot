import { StaleCandidateError } from "./freshness.js";
import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import type { SwapVMExecutionContext } from "./swapvm.js";
import type { Pool } from "./config.js";
import type { LiveFeeEstimate } from "./live-fees.js";
export const haircut = (amount: bigint, bps: number): bigint =>
  (amount * BigInt(10000 - bps)) / 10000n;
export const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
export type Leg = {
  venue: 0 | 1 | 2;
  target: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minOut: bigint;
  pool: Omit<Pool, "poolId">;
  hookData: Hex;
};
export type Trade = {
  id: Hex;
  deadline: bigint;
  validUntilBlock: bigint;
  minProfit: bigint;
  first: Leg;
  second: Leg;
};
export type Candidate = {
  /** Explicit policy floor, separate from any provisional screening allowance. */
  minimumNetProfit?: bigint;
  /** Present only after the exact guarded call has been estimated and simulated. */
  feeEstimate?: LiveFeeEstimate;
  trade: Trade;
  quotedProfit: bigint;
  netProfit: bigint;
  quotedAt: number;
  blockNumber: bigint;
  quoteBlockHash?: Hex;
  swapVM?: SwapVMExecutionContext;
  aquaFirst: boolean;
};
export async function findCandidates(params: {
  base: Address;
  other: Address;
  pool: Pool;
  router: Address;
  external: Address;
  amounts: bigint[];
  slippageBps: number;
  minNetProfit: bigint;
  gasCost: bigint;
  blockNumber: bigint;
  timestamp: bigint;
  quoteAqua: (input: Address, amount: bigint) => Promise<bigint>;
  quoteExternal: (input: Address, amount: bigint) => Promise<bigint>;
  onQuoteError?: (error: unknown) => void;
}): Promise<Candidate[]> {
  const p = params;
  const candidates: Candidate[] = [];
  for (const amount of p.amounts)
    for (const aquaFirst of [true, false]) {
      const quotedAt = Date.now();
      try {
        const firstQuote = aquaFirst ? p.quoteAqua : p.quoteExternal;
        const secondQuote = aquaFirst ? p.quoteExternal : p.quoteAqua;
        const out1 = await firstQuote(p.base, amount);
        const secondIn = haircut(out1, p.slippageBps);
        if (secondIn === 0n) continue;
        const out2 = await secondQuote(p.other, secondIn);
        const finalFloor = haircut(out2, p.slippageBps);
        const minProfit = p.gasCost + p.minNetProfit;
        if (finalFloor < amount + minProfit) continue;
        const { poolId: _, ...key } = p.pool;
        const leg = (
          aqua: boolean,
          input: Address,
          output: Address,
          inputAmount: bigint,
          minOut: bigint,
        ): Leg => ({
          venue: aqua ? 0 : 1,
          target: aqua ? p.router : p.external,
          tokenIn: input,
          tokenOut: output,
          amountIn: inputAmount,
          minOut,
          pool: key,
          hookData: "0x",
        });
        candidates.push({
          trade: {
            id: `0x${randomBytes(32).toString("hex")}`,
            deadline: p.timestamp + 60n,
            validUntilBlock: p.blockNumber + 2n,
            minProfit,
            first: leg(aquaFirst, p.base, p.other, amount, secondIn),
            second: leg(!aquaFirst, p.other, p.base, secondIn, finalFloor),
          },
          quotedProfit: out2 - amount,
          netProfit: finalFloor - amount - p.gasCost,
          minimumNetProfit: p.minNetProfit,
          quotedAt,
          blockNumber: p.blockNumber,
          aquaFirst,
        });
      } catch (error) {
        p.onQuoteError?.(error);
      }
    }
  return candidates.sort((a, b) =>
    a.netProfit > b.netProfit ? -1 : a.netProfit < b.netProfit ? 1 : 0,
  );
}
export function assertFresh(
  candidate: Pick<Candidate, "quotedAt" | "blockNumber">,
  head: bigint,
  now: number,
  maxAgeMs: number,
  maxBlockLag: number,
): void {
  if (
    now < candidate.quotedAt ||
    now - candidate.quotedAt > maxAgeMs ||
    head < candidate.blockNumber ||
    head - candidate.blockNumber > BigInt(maxBlockLag)
  )
    throw new StaleCandidateError(
      `Stale or reorged candidate: quoteBlock=${candidate.blockNumber}, rpcHead=${head}, ageMs=${now - candidate.quotedAt}, maxLag=${maxBlockLag}, maxAgeMs=${maxAgeMs}`,
    );
}
