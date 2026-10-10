import { forEachConcurrent } from "./opportunity-queue.js";
import {
  createPublicClient,
  http,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import { factoryAbi, quoterAbi, v3Abi, routerAbi, hookAbi } from "./abi.js";
import {
  same,
  rpcUrl,
  type ChainConfig,
  type Pool,
  type Venue,
} from "./config.js";
export function clientFor(chain: ChainConfig): PublicClient {
  return createPublicClient({
    cacheTime: 0,
    transport: http(rpcUrl(chain), { timeout: 12000, retryCount: 1 }),
  });
}
export type ExternalPool = { address: Address; fee: number; venue: Venue };
export async function verifyChain(
  client: PublicClient,
  chain: ChainConfig,
): Promise<void> {
  if ((await client.getChainId()) !== chain.chainId)
    throw new Error("RPC chain ID mismatch");
  for (const address of [
    chain.poolManager,
    chain.universalRouter,
    chain.permit2,
    chain.aqua0Hook,
  ])
    if (((await client.getCode({ address }))?.length ?? 0) <= 2)
      throw new Error("Registry contract has no bytecode");
  const manager = await client.readContract({
    address: chain.universalRouter,
    abi: routerAbi,
    functionName: "poolManager",
  });
  const hookManager = await client.readContract({
    address: chain.aqua0Hook,
    abi: hookAbi,
    functionName: "poolManager",
  });
  if (
    !same(manager, chain.poolManager) ||
    !same(hookManager, chain.poolManager)
  )
    throw new Error("PoolManager binding mismatch");
}
export async function discover(
  client: PublicClient,
  chain: ChainConfig,
  pool: Pick<Pool, "currency0" | "currency1">,
  blockNumber: bigint,
  requireActiveLiquidity = true,
): Promise<ExternalPool[]> {
  const found: ExternalPool[] = [];
  await forEachConcurrent(
    chain.venues.flatMap((venue) => venue.fees.map((fee) => ({ venue, fee }))),
    4,
    async ({ venue, fee }) => {
      const address = await client.readContract({
        address: venue.factory,
        abi: factoryAbi,
        functionName: "getPool",
        args: [pool.currency0, pool.currency1, fee],
        blockNumber,
      });
      if (address === zeroAddress) return;
      const [t0, t1, actualFee, liquidity] = await Promise.all([
        client.readContract({
          address,
          abi: v3Abi,
          functionName: "token0",
          blockNumber,
        }),
        client.readContract({
          address,
          abi: v3Abi,
          functionName: "token1",
          blockNumber,
        }),
        client.readContract({
          address,
          abi: v3Abi,
          functionName: "fee",
          blockNumber,
        }),
        client.readContract({
          address,
          abi: v3Abi,
          functionName: "liquidity",
          blockNumber,
        }),
      ]);
      if (
        !same(t0, pool.currency0) ||
        !same(t1, pool.currency1) ||
        actualFee !== fee
      )
        throw new Error("External pool binding mismatch");
      if (!requireActiveLiquidity || liquidity > 0n)
        found.push({ address, fee, venue });
    },
  );
  return found;
}
// Cached discovery is only a list of candidate addresses, never cached depth or execution permission.
// The backend revalidates the factory and reads current pool state before pricing every candidate.
const venueHints = new WeakMap<
  PublicClient,
  Map<string, { at: number; block: bigint; value: Promise<ExternalPool[]> }>
>();
export async function discoverCached(
  client: PublicClient,
  chain: ChainConfig,
  pair: Pick<Pool, "currency0" | "currency1">,
  block: bigint,
) {
  let cache = venueHints.get(client);
  if (!cache) {
    cache = new Map();
    venueHints.set(client, cache);
  }
  const key = JSON.stringify([
    chain.chainId,
    pair.currency0.toLowerCase(),
    pair.currency1.toLowerCase(),
    chain.venues,
  ]);
  const hit = cache.get(key);
  if (hit && block >= hit.block && Date.now() - hit.at < 30000)
    return hit.value;
  const value = discover(client, chain, pair, block, false).catch((error) => {
    cache!.delete(key);
    throw error;
  });
  cache.delete(key);
  cache.set(key, { at: Date.now(), block, value });
  while (cache.size > 128) cache.delete(cache.keys().next().value!);
  return value;
}
export async function quoteV3(
  client: PublicClient,
  quoter: Address,
  fee: number,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  blockNumber: bigint,
): Promise<bigint> {
  const { result } = await client.simulateContract({
    address: quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
    blockNumber,
  });
  if (result[0] === 0n) throw new Error("Empty V3 quote");
  return result[0];
}
