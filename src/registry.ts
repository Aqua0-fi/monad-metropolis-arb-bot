import { z } from "zod";
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
    return chainSchema.parse({
      ...c,
      publicRpc: policy?.publicRpc,
      feeModel: policy?.feeModel ?? "unsupported",
      extendedV4Encoding: policy?.extendedV4Encoding ?? false,
      venues: policy?.venues ?? [],
      executionReviewed: policy?.reviewed ?? false,
      nativeEquivalent: equivalent
        ? { token: equivalent.address, decimals: equivalent.decimals }
        : undefined,
    });
  });
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
