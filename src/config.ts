import { readFileSync } from "node:fs";
import { z } from "zod";
import { getAddress, type Address } from "viem";

export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((x) => getAddress(x.toLowerCase()));
export const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform(BigInt);
export const positive = uint.refine((x) => x > 0n);
export const hex = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
  .transform((x) => x as `0x${string}`);
export const poolSchema = z.object({
  poolId: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((x) => x as `0x${string}`),
  currency0: address,
  currency1: address,
  fee: z.number().int().min(0).max(16777215),
  tickSpacing: z.number().int().positive(),
  hooks: address,
});
export const swapVMDeploymentSchema = z.object({
  router: address,
  aqua: address,
  maker: address,
  slices: z.union([z.literal(9), z.literal(10)]),
});

const venueSchema = z.object({
  name: z.string(),
  factory: address,
  quoter: address,
  fees: z.array(z.number().int().positive().max(1000000)).min(1).max(8),
});
export const chainSchema = z.object({
  chainId: z.number().int().positive(),
  feeModel: z.enum(["op-stack", "gas-limit", "unsupported"]),
  executionReviewed: z.boolean().default(false),
  nativeCurrency: z
    .object({ symbol: z.string(), decimals: z.number().int().min(0).max(36) })
    .optional(),
  nativeEquivalent: z
    .object({ token: address, decimals: z.number().int().min(0).max(36) })
    .optional(),
  name: z.string(),
  rpcEnv: z.string(),
  publicRpc: z.url().optional(),
  poolManager: address,
  universalRouter: address,
  permit2: address,
  aqua0Hook: address,
  extendedV4Encoding: z.boolean(),
  pools: z.array(poolSchema),
  venues: z.array(venueSchema),
  swapVM: swapVMDeploymentSchema.optional(),
});
export type ChainConfig = z.infer<typeof chainSchema>;
export type Pool = z.infer<typeof poolSchema>;
export type Venue = z.infer<typeof venueSchema>;
const marketSchema = z.object({
  chainId: z.number().int().positive(),
  poolId: poolSchema.shape.poolId,
  classId: positive,
  baseToken: address,
  amounts: z.array(positive).max(8).default([]),
  minNetProfit: positive,
  maxInput: positive,
  // Screening-only gas allowance in base-token units. Real fees are measured before signing.
  screenGasCost: uint.optional(),
});
export type Market = z.infer<typeof marketSchema>;
const quoteFeeSchema = z
  .object({
    maxGasUnits: positive,
    liveFeeBufferBps: z.number().int().min(10000).max(20000).optional(),
    maxFeePerGas: positive,
    l1FeeReserveWei: uint,
    wrappedNative: address,
    gasConversionFee: z.number().int().positive(),
    gasCostBufferBps: z.number().int().min(10000).max(30000).default(13000),
    // Opaque programs may inspect msg.sender. Configure the intended caller for observation.
    caller: address.optional(),
  })
  .strict();
const budgetLimitSchema = z
  .object({
    perMinute: z.number().int().min(0).max(600),
    perHour: z.number().int().min(0).max(20000),
    perDay: z.number().int().min(0).max(200000),
  })
  .strict();
export const settingsSchema = z.object({
  // Hard caps on Aqua0 backend requests (each spends the backend's paid RPC). Persisted across restarts.
  backendBudget: z
    .object({
      file: z.string().min(1).default("runtime/backend-budget.json"),
      catalog: budgetLimitSchema.default({
        perMinute: 2,
        perHour: 30,
        perDay: 200,
      }),
      search: budgetLimitSchema.default({
        perMinute: 6,
        perHour: 120,
        perDay: 600,
      }),
      authorize: budgetLimitSchema.default({
        perMinute: 2,
        perHour: 20,
        perDay: 60,
      }),
    })
    .strict()
    .prefault({}),
  // "optimize" asks the backend to search every head (operator tier, expensive). "quote-grid" screens
  // with free data (the backend's own price feed + the external pool on the worker's RPC) and asks the
  // backend for one read-tier quote only when the screen shows a profitable gap.
  v4Search: z
    .object({
      mode: z.enum(["optimize", "quote-grid"]).default("optimize"),
      feedUrl: z.url().default("https://coins.llama.fi/prices/current"),
      // Lowercase token address -> "usd-stable" (the backend's fixed $1 model) or a DefiLlama key.
      feedKeys: z.record(z.string(), z.string().min(1)).default({}),
      feedMaxAgeMs: z.number().int().min(10000).max(600000).default(300000),
      feedRefreshMs: z.number().int().min(15000).max(600000).default(60000),
      // Extra screening margin over pool fees, slippage and the gas allowance.
      marginBps: z.number().int().min(0).max(1000).default(5),
      // Do not re-ask the backend about an unchanged market sooner than this.
      minBackendIntervalMs: z
        .number()
        .int()
        .min(1000)
        .max(3600000)
        .default(15000),
      sizesPerScreen: z.number().int().min(1).max(8).default(4),
      // Chain ID -> external pools the V4 search may price (observe mode; execute mode uses
      // execution.externalPools). Unset means every discovered pool, as before.
      externalPools: z
        .record(z.string(), z.array(address).min(1).max(16))
        .default({}),
    })
    .strict()
    .prefault({}),
  // The process stops itself after this long. Pilot runs must set it.
  maxRuntimeMs: z.number().int().min(10000).max(86400000).optional(),
  observations: z
    .object({
      enabled: z.boolean().default(true),
      balanceIntervalMs: z
        .number()
        .int()
        .min(30000)
        .max(3600000)
        .default(60000),
      maxRecords: z.number().int().min(1000).max(1000000).default(200000),
    })
    .prefault({}),
  scheduling: z
    .object({
      headerPollMs: z.number().int().min(100).max(10000).default(500),
      websocketAuditMs: z.number().int().min(1000).max(60000).default(5000),
      maxConcurrentChains: z.number().int().min(1).max(8).default(4),
      maxScanMs: z.number().int().min(500).max(30000).default(8000),
      maxScanBlockLag: z.number().int().min(0).max(20).default(8),
      websocketEnv: z
        .record(z.string(), z.string().regex(/^[A-Z][A-Z0-9_]*$/))
        .default({}),
    })
    .prefault({}),
  quoteFees: z.record(z.string(), quoteFeeSchema).default({}),
  mode: z.enum(["observe", "execute"]).default("observe"),
  networkMode: z.enum(["mainnet", "fork"]).default("mainnet"),
  apiUrl: z.url(),
  pollMs: z.number().int().min(1000).default(15000),
  slippageBps: z.number().int().min(0).max(100).default(10),
  maxQuoteAgeMs: z.number().int().min(500).max(60000).default(10000),
  maxBlockLag: z.number().int().min(0).max(20).default(8),
  confirmations: z.number().int().min(1).default(2),
  maxConsecutiveErrors: z.number().int().positive().default(5),
  markets: z.array(marketSchema).default([]),
  discovery: z
    .object({
      enabled: z.boolean().default(false),
      intervalMs: z.number().int().min(30000).max(3600000).default(120000),
      maxAgeMs: z.number().int().min(60000).max(3600000).default(600000),
    })
    .default({ enabled: false, intervalMs: 120000, maxAgeMs: 600000 }),
  execution: z
    .record(
      z.string(),
      z
        .object({
          executor: address,
          operator: address,
          privateKeyEnv: z.string().min(1).optional(),
          kms: z
            .object({
              region: z.string().regex(/^[a-z0-9-]+$/),
              keyId: z
                .string()
                .regex(
                  /^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key\/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$/,
                ),
            })
            .optional(),
          allowBroadcast: z.boolean().default(false),
          externalPools: z.array(address).min(1).max(64).optional(),
          maxGasUnits: positive,
          liveFeeBufferBps: z.number().int().min(10000).max(20000).optional(),
          gasLimitBufferBps: z.number().int().min(10000).max(15000).optional(),
          maxFeePerGas: positive,
          l1FeeReserveWei: uint,
          maxDailyGasWei: positive,
          // Conversion is priced through a real V3 quoter; it is not a floating point USD assumption.
          wrappedNative: address,
          gasConversionFee: z.number().int().positive(),
          gasCostBufferBps: z
            .number()
            .int()
            .min(10000)
            .max(30000)
            .default(13000),
        })
        .superRefine((config, ctx) => {
          if (Boolean(config.privateKeyEnv) === Boolean(config.kms))
            ctx.addIssue({
              code: "custom",
              message:
                "Choose exactly one signer: a dedicated KMS key or a local private-key variable",
            });
          if (
            config.kms &&
            config.kms.keyId.split(":")[3] !== config.kms.region
          )
            ctx.addIssue({
              code: "custom",
              message: "KMS key region does not match configuration",
            });
        }),
    )
    .default({}),
});
export type Settings = z.infer<typeof settingsSchema>;
export function loadChains(path = "config/chains.json"): ChainConfig[] {
  const parsed = z
    .object({ chains: z.array(chainSchema) })
    .parse(JSON.parse(readFileSync(path, "utf8")));
  if (
    new Set(parsed.chains.map((c) => c.chainId)).size !== parsed.chains.length
  )
    throw new Error("Duplicate chain");
  return parsed.chains;
}
export function loadSettings(path: string): Settings {
  const settings = settingsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (!settings.discovery.enabled && settings.markets.length === 0)
    throw new Error("Configure markets or enable public V4 discovery");
  for (const m of settings.markets)
    if (m.amounts.some((a) => a > m.maxInput))
      throw new Error("Sample exceeds market maxInput");
  return settings;
}
export function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
export function rpcUrl(chain: ChainConfig): string {
  const url = process.env[chain.rpcEnv] ?? chain.publicRpc;
  if (!url) throw new Error(`RPC not configured: ${chain.rpcEnv}`);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new Error("RPC must use HTTP(S)");
  return url;
}
export function findPool(chain: ChainConfig, market: Market): Pool {
  const pool = chain.pools.find((p) => same(p.poolId, market.poolId));
  if (
    !pool ||
    !same(pool.hooks, chain.aqua0Hook) ||
    (!same(market.baseToken, pool.currency0) &&
      !same(market.baseToken, pool.currency1))
  )
    throw new Error("Market is not an Aqua0 registry pool");
  return pool;
}
export const zero = "0x0000000000000000000000000000000000000000" as Address;
