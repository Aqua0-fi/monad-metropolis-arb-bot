import { z } from "zod";
import { encodeAbiParameters, keccak256 } from "viem";
import {
  chainSchema,
  swapVMDeploymentSchema,
  address,
  poolSchema,
  type ChainConfig,
} from "./config.js";

/** Protocol identities come from the registry; execution support is reviewed separately. */
export const canonicalChainSchema = z.object({
  swapVM: swapVMDeploymentSchema.optional(),
  chainId: z.number().int().positive(),
  name: z.string().min(1),
  rpcEnv: z.string().min(1),
  nativeCurrency: z.object({
    symbol: z.string().min(1),
    decimals: z.number().int().min(0).max(36),
  }),
  poolManager: address,
  universalRouter: address,
  permit2: address,
  aqua0Hook: address,
  pools: z.array(poolSchema),
  tokens: z.array(
    z.object({
      symbol: z.string(),
      address,
      decimals: z.number().int().min(0).max(36),
    }),
  ),
});
export type CanonicalChain = z.infer<typeof canonicalChainSchema>;
export const executionPolicySchema = z.object({
  publicRpc: z.url().optional(),
  feeModel: z.enum(["op-stack", "gas-limit", "unsupported"]),
  extendedV4Encoding: z.boolean(),
  reviewed: z.boolean(),
  nativeEquivalentSymbol: z.string().optional(),
  // A wrapped-native token that is not an Aqua0 vault asset (e.g. WMON) is reviewed here directly.
  nativeEquivalent: chainSchema.shape.nativeEquivalent,
  // Live Aqua0 pools the backend registry does not list yet. Each key must use the canonical hook;
  // its pool ID is recomputed so a typo cannot alias another pool.
  additionalPools: z.array(poolSchema).optional(),
  venues: chainSchema.shape.venues,
});
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

export function buildChainRegistry(
  source: readonly CanonicalChain[],
  policies: Readonly<Record<string, ExecutionPolicy>>,
): ChainConfig[] {
  if (new Set(source.map((c) => c.chainId)).size !== source.length)
    throw new Error("Duplicate canonical chain");
  return source.map((raw) => {
    const c = canonicalChainSchema.parse(raw);
    const policy = policies[String(c.chainId)];
    const equivalents = policy?.nativeEquivalentSymbol
      ? c.tokens.filter(
          (t) =>
            t.symbol.toLowerCase() ===
            policy.nativeEquivalentSymbol?.toLowerCase(),
        )
      : [];
    if (equivalents.length > 1)
      throw new Error(`Native gas token identity is ambiguous on ${c.chainId}`);
    const equivalent = equivalents[0];
    if (policy?.nativeEquivalentSymbol && !equivalent)
      throw new Error(
        `Native gas token missing from canonical registry on ${c.chainId}`,
      );
    if (policy?.nativeEquivalentSymbol && policy.nativeEquivalent)
      throw new Error(`Configure one native gas token source on ${c.chainId}`);
    const extra = policy?.additionalPools ?? [];
    for (const pool of extra) {
      if (pool.hooks.toLowerCase() !== c.aqua0Hook.toLowerCase())
        throw new Error(`Additional pool ${pool.poolId} uses another hook`);
      if (poolIdOf(pool) !== pool.poolId.toLowerCase())
        throw new Error(`Additional pool ${pool.poolId} has a mismatched ID`);
    }
    const pools = [...c.pools];
    for (const pool of extra)
      if (
        !pools.some((p) => p.poolId.toLowerCase() === pool.poolId.toLowerCase())
      )
        pools.push(pool);
    return chainSchema.parse({
      ...c,
      pools,
      publicRpc: policy?.publicRpc,
      feeModel: policy?.feeModel ?? "unsupported",
      extendedV4Encoding: policy?.extendedV4Encoding ?? false,
      venues: policy?.venues ?? [],
      executionReviewed: policy?.reviewed ?? false,
      nativeEquivalent: equivalent
        ? { token: equivalent.address, decimals: equivalent.decimals }
        : policy?.nativeEquivalent,
    });
  });
}

/** Uniswap V4 PoolId = keccak256(abi.encode(PoolKey)). */
export function poolIdOf(pool: {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}): string {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [
        pool.currency0 as `0x${string}`,
        pool.currency1 as `0x${string}`,
        pool.fee,
        pool.tickSpacing,
        pool.hooks as `0x${string}`,
      ],
    ),
  ).toLowerCase();
}

export function registryBlockers(chain: ChainConfig): string[] {
  const blocked: string[] = [];
  if (!chain.executionReviewed)
    blocked.push("Execution adapter has not been reviewed for this chain");
  if (chain.feeModel === "unsupported")
    blocked.push("Native/network fee model is unsupported");
  if (chain.pools.length === 0)
    blocked.push("Canonical registry has no configured V4 pool");
  if (chain.venues.length === 0)
    blocked.push("No supported external venue configured");
  return blocked;
}
