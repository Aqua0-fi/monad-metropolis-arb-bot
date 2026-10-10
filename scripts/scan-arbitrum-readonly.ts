import { readFileSync, lstatSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  http,
  parseAbi,
  formatUnits,
  getAddress,
  type Address,
} from "viem";
import { loadChains } from "../src/config.js";

// Read-only owner-requested screening. Calls only the two documented numerical-search endpoints.
// No authorization endpoint, KMS, wallet, trade activation or service-configuration write is used.
const path =
  "/Users/rithikkumars/CodingStuff/Aqua0/secrets/market-rebalancer-observer.json";
const stat = lstatSync(path);
if (
  stat.isSymbolicLink() ||
  !stat.isFile() ||
  stat.uid !== process.getuid?.() ||
  (stat.mode & 0o777) !== 0o600
)
  throw new Error("Unsafe read credential file");
const key = JSON.parse(readFileSync(path, "utf8")).AQUA0_READ_API_KEY;
if (typeof key !== "string" || key.length < 16)
  throw new Error("Missing dedicated read key");
const catalog = JSON.parse(
  readFileSync("../evidence/arbitrum-other-markets-20260929.json", "utf8"),
);
if (
  catalog.chainId !== 42161 ||
  catalog.swapVM.network !== "mainnet" ||
  Date.now() - Date.parse(catalog.observedAt) > 20 * 60 * 1000
)
  throw new Error("Require a fresh Arbitrum mainnet catalog");
const chain = loadChains().find((c) => c.chainId === 42161)!;
const rpc = createPublicClient({
  transport: http(chain.publicRpc, { timeout: 10000, retryCount: 0 }),
});
if ((await rpc.getChainId()) !== 42161) throw new Error("Wrong chain");
const block = await rpc.getBlock();
const base = getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
  weth = getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const caller = getAddress(
  JSON.parse(
    readFileSync("../evidence/arbitrum-unsigned-launch-20260929.json", "utf8"),
  ).predictedExecutor,
);
const abi = parseAbi([
  "function getPool(address,address,uint24) view returns(address)",
  "function factory() view returns(address)",
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function fee() view returns(uint24)",
  "function liquidity() view returns(uint128)",
  "function decimals() view returns(uint8)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)",
]);
const read = async (
  address: Address,
  functionName: string,
  args: readonly unknown[] = [],
) =>
  rpc.readContract({
    address,
    abi,
    functionName,
    args,
    blockNumber: block.number,
  } as never) as Promise<any>;
if (
  (await read(base, "decimals")) !== 6 ||
  (await read(weth, "decimals")) !== 18
)
  throw new Error("Canonical token scale mismatch");
const records: any[] = [],
  pools = new Map<
    string,
    Array<{
      pool: Address;
      factory: Address;
      quoter: Address;
      fee: number;
      name: string;
      liquidity: bigint;
    }>
  >();
async function discover(a: Address, b: Address) {
  const tokens = [getAddress(a), getAddress(b)].sort((x, y) =>
    BigInt(x) < BigInt(y) ? -1 : 1,
  ) as [Address, Address];
  const id = tokens.join(":");
  if (pools.has(id)) return pools.get(id)!;
  const found: Array<{
    pool: Address;
    factory: Address;
    quoter: Address;
    fee: number;
    name: string;
    liquidity: bigint;
  }> = [];
  for (const venue of chain.venues) {
    for (const fee of venue.fees) {
      try {
        const pool = (await read(venue.factory, "getPool", [
          ...tokens,
          fee,
        ])) as Address;
        if (BigInt(pool) === 0n) continue;
        const [factory, t0, t1, actualFee, liquidity] = await Promise.all([
          read(pool, "factory"),
          read(pool, "token0"),
          read(pool, "token1"),
          read(pool, "fee"),
          read(pool, "liquidity"),
        ]);
        if (
          getAddress(factory) !== getAddress(venue.factory) ||
          getAddress(t0) !== tokens[0] ||
          getAddress(t1) !== tokens[1] ||
          actualFee !== fee
        )
          throw new Error("External pool identity mismatch");
        if (liquidity > 0n)
          found.push({
            pool,
            factory: venue.factory,
            quoter: venue.quoter,
            fee,
            name: venue.name,
            liquidity,
          });
      } catch (error) {
        records.push({
          kind: "discovery",
          pair: tokens,
          venue: venue.name,
          fee,
          unavailable: true,
          error: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
  }
  pools.set(id, found);
  return found;
}
// Read-only searches do not yet have a funded, permissioned full transaction to estimate.
// Collect gross candidates only; zero here is a model input, never a claim that network fees are zero.
const gasBudget = 0n;
const jobs: Array<{
  label: unknown;
  route: string;
  body: Record<string, unknown>;
}> = [];
for (const entry of catalog.v4) {
  if (!entry.tokens.some((t: any) => getAddress(t.address) === base)) continue;
  if (entry.blockers.length) {
    records.push({
      kind: "v4",
      poolId: entry.pool.poolId,
      blocked: entry.blockers,
    });
    continue;
  }
  const markets = await discover(entry.pool.currency0, entry.pool.currency1);
  if (!markets.length)
    records.push({
      kind: "v4",
      poolId: entry.pool.poolId,
      noSupportedExternalPool: true,
    });
  for (const cls of entry.classIds)
    for (const market of markets)
      jobs.push({
        label: {
          kind: "v4",
          poolId: entry.pool.poolId,
          classId: String(cls),
          pair: entry.tokens.map((t: any) => t.symbol),
          externalPool: market.pool,
          venue: market.name,
          fee: market.fee,
        },
        route: "/api/swap/optimize-round-trip",
        body: {
          venue: "v4",
          chainId: 42161,
          poolId: entry.pool.poolId,
          classId: String(cls),
          token0: entry.pool.currency0,
          token1: entry.pool.currency1,
          tickSpacing: entry.pool.tickSpacing,
          baseToken: base,
          externalPool: market.pool,
          externalFactory: market.factory,
          maxInput: "5000000",
          minNetProfit: "10000",
          fee: entry.pool.fee,
          gasBudget: String(gasBudget),
          slippageBps: 10,
        },
      });
}
for (const entry of catalog.swapVM.markets) {
  if (![entry.token0, entry.token1].some((t: string) => getAddress(t) === base))
    continue;
  const markets = await discover(entry.token0, entry.token1);
  if (!markets.length)
    records.push({
      kind: "aqua",
      strategyId: entry.stableStrategyId,
      noSupportedExternalPool: true,
    });
  for (const market of markets)
    jobs.push({
      label: {
        kind: "aqua",
        strategyId: entry.stableStrategyId,
        classId: entry.classId,
        pair: entry.tokens.map((t: any) => t.symbol),
        externalPool: market.pool,
        venue: market.name,
        fee: market.fee,
      },
      route: "/api/swap/optimize-aqua-round-trip",
      body: {
        venue: "aqua",
        chainId: 42161,
        stableStrategyId: entry.stableStrategyId,
        caller,
        baseToken: base,
        externalPool: market.pool,
        externalFactory: market.factory,
        maxInput: "5000000",
        minNetProfit: "10000",
        gasBudget: String(gasBudget),
        slippageBps: 10,
        searchBudgetMs: 1000,
      },
    });
}
if (jobs.length > 100) throw new Error("Refusing an unexpectedly large scan");
const report = () => ({
  observedAt: new Date().toISOString(),
  chainId: 42161,
  discoveryBlock: String(block.number),
  caller,
  inputCapUsdc: "5",
  feeScenario: {
    status: "unestimated-gross-only",
    estimatedNetProfit: null,
    note: "Each selected executable transaction requires live gas estimation, actual fee conversion and the configured 5% buffer before signing.",
  },
  totalSearches: jobs.length,
  records,
  authorizationRequests: 0,
  liveSettingsChanged: false,
  publicTransactions: 0,
  qualification:
    "Current read-only backend optimization for discovered native-USDC starting routes, bounded to 5 USDC. The response netProfit field is a gross-search model result with zero fee input, not estimated net profit after gas. A quote is not full transaction proof; unavailable searches are not zero profit. Non-USDC routes are not screened.",
});
const save = () =>
  writeFileSync(
    "../evidence/arbitrum-gross-route-scan-20260929.json",
    JSON.stringify(
      report(),
      (_key, v) => (typeof v === "bigint" ? String(v) : v),
      2,
    ) + "\n",
    { mode: 0o600 },
  );
console.log(
  JSON.stringify({
    searches: jobs.length,
    feeStatus: "unestimated-gross-only",
    estimatedNetProfit: null,
  }),
);
for (const job of jobs) {
  const started = Date.now();
  try {
    const response = await fetch(
      new URL(job.route, "https://staging-api.aqua0.xyz"),
      {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": key,
          "X-Network-Mode": "mainnet",
        },
        body: JSON.stringify(job.body),
        signal: AbortSignal.timeout(9000),
      },
    );
    const raw = await response.text();
    if (raw.length > 150000) throw new Error("Oversized response");
    const data = JSON.parse(raw);
    if (response.status === 401 || response.status === 403) {
      records.push({
        label: job.label,
        http: response.status,
        authorizationRefused: true,
      });
      save();
      throw new Error(
        "Dedicated read access refused; stop instead of trying another credential",
      );
    }
    records.push({
      label: job.label,
      http: response.status,
      elapsedMs: Date.now() - started,
      result: data,
    });
    console.log(
      JSON.stringify({
        label: job.label,
        http: response.status,
        elapsedMs: Date.now() - started,
        candidates: data.candidates?.length ?? null,
        reason: data.reason ?? data.code ?? null,
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Dedicated read access refused")
    )
      throw error;
    records.push({
      label: job.label,
      unavailable: true,
      error: error instanceof Error ? error.name : "UnknownError",
      elapsedMs: Date.now() - started,
    });
  }
  save();
  await new Promise((resolve) => setTimeout(resolve, 250));
}
console.log(
  "Read-only scan complete. No authorization, signing, market approval or broadcast occurred.",
);
