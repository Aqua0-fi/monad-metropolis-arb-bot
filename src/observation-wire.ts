import { z } from "zod";
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase());
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((s) => s.toLowerCase());
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(80);
const sint = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)$/)
  .max(81);
const timestamp = z.iso.datetime();
export const opportunityState = z.enum([
  "found",
  "observed",
  "transaction-prepared",
  "not-selected",
  "rechecking",
  "unprofitable",
  "stale",
  "disappeared",
  "blocked",
  "submitted",
  "interrupted",
]);
export const opportunitySchema = z
  .object({
    id: hash,
    network: z.enum(["mainnet", "fork"]),
    chainId: z.number().int().positive().safe(),
    venue: z.enum(["v4", "aqua"]),
    marketId: hash,
    classId: uint,
    caller: address.nullable(),
    baseToken: address,
    otherToken: address,
    externalPool: address,
    aquaFirst: z.boolean(),
    amountIn: uint,
    executionAmountIn: uint.nullable().default(null),
    quotedGross: sint,
    conservativeGross: sint,
    estimatedFee: uint.nullable(),
    estimatedNet: sint.nullable(),
    quoteBlock: uint,
    quoteBlockHash: hash,
    foundAt: timestamp,
    updatedAt: timestamp,
    quoteObservedAt: timestamp,
    state: opportunityState,
    reason: z.string().max(400).nullable(),
    transactionHash: hash.nullable(),
    executionTradeId: hash.nullable(),
  })
  .strict()
  .refine(
    (r) => r.estimatedNet === null || r.estimatedFee !== null,
    "Net estimates require a fee estimate",
  );
export type OpportunityRecord = z.infer<typeof opportunitySchema>;
export const balanceObservationSchema = z
  .object({
    network: z.enum(["mainnet", "fork"]),
    chainId: z.number().int().positive().safe(),
    role: z.enum(["executor", "operator"]),
    wallet: address,
    asset: address.nullable(),
    symbol: z.string().min(1).max(32).nullable(),
    decimals: z.number().int().min(0).max(36).nullable(),
    amount: uint.nullable(),
    blockNumber: uint.nullable(),
    blockHash: hash.nullable(),
    blockTimestamp: timestamp.nullable(),
    observedAt: timestamp,
    source: z.enum(["periodic", "receipt-checkpoint"]),
    issue: z.string().max(200).nullable(),
  })
  .strict()
  .refine(
    (r) =>
      r.amount === null
        ? r.issue !== null
        : r.issue === null &&
          r.blockNumber !== null &&
          r.blockHash !== null &&
          r.decimals !== null,
    "Balances require complete block identity and units; unavailable reads are explicit",
  );
export type BalanceObservation = z.infer<typeof balanceObservationSchema>;
export const observationQuerySchema = z
  .object({
    network: z.enum(["mainnet", "fork"]),
    chainId: z.coerce.number().int().positive().safe().optional(),
    from: timestamp.optional(),
    to: timestamp.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    cursor: z.string().max(1024).optional(),
    state: opportunityState.optional(),
    role: z.enum(["executor", "operator"]).optional(),
    wallet: address.optional(),
    asset: z.union([address, z.literal("native")]).optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, "Invalid time window");
export type ObservationQuery = z.input<typeof observationQuerySchema>;
export interface ObservationCoverage {
  startedAt: string;
  oldestRetainedAt: string | null;
  newestRetainedAt: string | null;
  removedRecords: number;
  retainedLimit: number;
  note: string;
}
export interface OpportunityPage {
  version: 1;
  network: "mainnet" | "fork";
  generatedAt: string;
  items: (OpportunityRecord & { sequence: number })[];
  matchedCount: number;
  nextCursor: string | null;
  coverage: ObservationCoverage;
}
export interface BalancePage {
  version: 1;
  network: "mainnet" | "fork";
  generatedAt: string;
  items: (BalanceObservation & { sequence: number })[];
  series: (BalanceObservation & { sequence: number })[];
  seriesTruncated: boolean;
  matchedCount: number;
  nextCursor: string | null;
  coverage: ObservationCoverage;
}
