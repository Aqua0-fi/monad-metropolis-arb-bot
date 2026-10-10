import { z } from "zod";
import type { ExecutionRecord } from "./history.js";
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(80);
const addr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((x) => x.toLowerCase());
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((x) => x.toLowerCase());
/** Native fees are actual receipt costs; the token conversion is an explicitly labelled historical valuation. */
export const feeValuationSchema = z
  .object({
    version: z.literal(1),
    token: addr,
    tokenCost: uint,
    nativeCost: uint,
    blockNumber: uint,
    blockHash: hash,
    tokenDecimals: z.number().int().min(0).max(36),
    tokenSymbol: z.string().min(1).max(32),
    nativeDecimals: z.number().int().min(0).max(36),
    nativeSymbol: z.string().min(1).max(32),
    method: z.enum(["native-equivalent", "v3-exact-output"]),
    conversionToken: addr,
    conversionAmount: uint,
    quoter: addr.nullable(),
    pool: addr.nullable(),
    fee: z.number().int().min(0).max(1000000).nullable(),
  })
  .strict();
export type FeeValuation = z.infer<typeof feeValuationSchema>;
export const economicsReviewSchema = z
  .object({
    expectedVersion: z.number().int().safe().nonnegative(),
    throughSettlement: z.number().int().safe().nonnegative(),
    reason: z.string().trim().min(3).max(500),
    acknowledgeLosses: z.literal(true),
  })
  .strict();
export type EconomicsReview = z.infer<typeof economicsReviewSchema>;
export interface EconomicBucket {
  chainId: number;
  token: string;
  tokenDecimals: number | null;
  tokenSymbol: string | null;
  nativeDecimals: number | null;
  nativeSymbol: string | null;
  confirmed: number;
  reverted: number;
  profitable: number;
  lossMaking: number;
  breakEven: number;
  unknownCost: number;
  unknownNativeCost: number;
  grossProfit: string;
  nativeFees: string;
  feesInToken: string;
  knownNetResult: string;
  netResult: string | null;
}
export function valuedCost(record: ExecutionRecord): bigint | null {
  const r = record.receipt,
    v = r?.feeValuation;
  if (
    !r ||
    !v ||
    r.totalGasNative === null ||
    v.nativeCost !== r.totalGasNative ||
    v.token !== record.tokenIn ||
    v.blockNumber !== r.blockNumber ||
    v.blockHash !== r.blockHash
  )
    return null;
  if (record.status === "confirmed" && r.grossProfit === null) return null;
  return BigInt(v.tokenCost);
}
export function summarizeEconomics(
  records: Iterable<ExecutionRecord>,
): EconomicBucket[] {
  const groups = new Map<string, EconomicBucket>();
  for (const r of records) {
    if (r.status === "pending" || !r.receipt) continue;
    const key = `${r.chainId}:${r.tokenIn}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        chainId: r.chainId,
        token: r.tokenIn,
        tokenDecimals: null,
        tokenSymbol: null,
        nativeDecimals: null,
        nativeSymbol: null,
        confirmed: 0,
        reverted: 0,
        profitable: 0,
        lossMaking: 0,
        breakEven: 0,
        unknownCost: 0,
        unknownNativeCost: 0,
        grossProfit: "0",
        nativeFees: "0",
        feesInToken: "0",
        knownNetResult: "0",
        netResult: "0",
      };
      groups.set(key, g);
    }
    const gross =
      r.status === "confirmed" ? BigInt(r.receipt.grossProfit ?? "0") : 0n;
    g[r.status]++;
    g.grossProfit = String(BigInt(g.grossProfit) + gross);
    if (r.receipt.totalGasNative === null) g.unknownNativeCost++;
    else
      g.nativeFees = String(
        BigInt(g.nativeFees) + BigInt(r.receipt.totalGasNative),
      );
    const cost = valuedCost(r);
    if (cost === null) {
      g.unknownCost++;
      continue;
    }
    const v = r.receipt.feeValuation!;
    if (g.tokenDecimals === null) {
      g.tokenDecimals = v.tokenDecimals;
      g.tokenSymbol = v.tokenSymbol;
      g.nativeDecimals = v.nativeDecimals;
      g.nativeSymbol = v.nativeSymbol;
    } else if (
      g.tokenDecimals !== v.tokenDecimals ||
      g.nativeDecimals !== v.nativeDecimals
    ) {
      g.unknownCost++;
      continue;
    }
    const net = gross - cost;
    g.feesInToken = String(BigInt(g.feesInToken) + cost);
    g.knownNetResult = String(BigInt(g.knownNetResult) + net);
    if (net > 0n) g.profitable++;
    else if (net < 0n) g.lossMaking++;
    else g.breakEven++;
  }
  for (const g of groups.values())
    g.netResult = g.unknownCost ? null : g.knownNetResult;
  return [...groups.values()].sort(
    (a, b) => a.chainId - b.chainId || a.token.localeCompare(b.token),
  );
}
export type EconomicPauseReason =
  | "net_loss"
  | "cost_unavailable"
  | "canonicality_unavailable"
  | "canonicality_changed";
export interface EconomicsSnapshot {
  version: number;
  network: "mainnet" | "fork";
  reviewedThrough: number;
  throughSettlement: number;
  blocked: boolean;
  reason: EconomicPauseReason | null;
  pending: number;
  totals: EconomicBucket[];
  window: EconomicBucket[];
  lastReview: { at: string; actor: string; reason: string } | null;
  audit: {
    at: string;
    actor: string;
    reason: string;
    throughSettlement: number;
    previousResult: unknown;
  }[];
  valuationBasis: "actual-native-fees-and-receipt-block-token-replacement-cost";
}
