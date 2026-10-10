import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  http,
  parseAbi,
  keccak256,
  getAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { loadChains } from "../src/config.js";

// Read-only discovery and pinned onchain verification. No signer or transaction transport is created.
const { values } = parseArgs({
  options: {
    chain: { type: "string", default: "42161" },
    output: {
      type: "string",
      default: "config/production-maker-arbitrum-fork.json",
    },
  },
});
const chain = loadChains().find((c) => String(c.chainId) === values.chain);
if (!chain?.swapVM || !chain.executionReviewed)
  throw new Error("No reviewed chain and canonical SwapVM bindings");
const key = process.env.AQUA0_API_KEY;
if (!key) throw new Error("A dedicated read-tier AQUA0_API_KEY is required");
const endpoint = new URL(
  "/api/swap/aqua-markets",
  "https://staging-api.aqua0.xyz",
);
endpoint.searchParams.set("chainId", String(chain.chainId));
const response = await fetch(endpoint, {
  headers: {
    "X-API-Key": key,
    "X-Network-Mode": "mainnet",
    Accept: "application/json",
  },
  signal: AbortSignal.timeout(45000),
});
if (!response.ok)
  throw new Error(`Read-only discovery returned HTTP ${response.status}`);
const payload = (await response.json()) as {
  chainId: number;
  network: string;
  markets: Array<{
    chainId: number;
    stableStrategyId: Hex;
    currentAquaHash: Hex;
    classId: string;
    router: Address;
    aqua: Address;
    maker: Address;
    token0: Address;
    token1: Address;
    slices: number;
    tokens: Array<{ address: Address; symbol: string; decimals: number }>;
    order: { maker: Address; traits: string; data: Hex };
    blockNumber: string;
    blockHash: Hex;
  }>;
};
if (payload.chainId !== chain.chainId || payload.network !== "mainnet")
  throw new Error("Discovery network mismatch");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const market = payload.markets.find(
  (m) =>
    m.tokens.length === 2 &&
    m.tokens.every((t) => t.decimals === 6) &&
    m.tokens.some((t) => t.symbol.toLowerCase() === "usdc") &&
    m.tokens.some((t) => t.symbol.toLowerCase() === "usdt"),
);
if (!market)
  throw new Error(
    "No current six-decimal USDC/USDT production strategy; do not invent a fixture",
  );
if (
  !same(market.router, chain.swapVM.router) ||
  !same(market.aqua, chain.swapVM.aqua) ||
  !same(market.maker, chain.swapVM.maker)
)
  throw new Error("Discovery does not match canonical deployment");
const rpc = createPublicClient({
  transport: http(process.env[chain.rpcEnv] || chain.publicRpc, {
    timeout: 15000,
    retryCount: 1,
  }),
});
if ((await rpc.getChainId()) !== chain.chainId)
  throw new Error("RPC chain mismatch");
const block = await rpc.getBlock();
const abi = parseAbi([
  "function currentAquaHash(bytes32) view returns(bytes32)",
  "function strategyClassId(bytes32) view returns(uint256)",
  "function aqua() view returns(address)",
  "function aquaSwapVMRouter() view returns(address)",
  "function registry() view returns(address)",
  "function vaultForAsset(address) view returns(address)",
  "function availableFor(uint256) view returns(uint256)",
  "function committersOf(uint256) view returns(address[])",
  "function freePrincipal(address) view returns(uint256)",
  "function getPool(address,address,uint24) view returns(address)",
  "function factory() view returns(address)",
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function liquidity() view returns(uint128)",
  "function decimals() view returns(uint8)",
  "function hash((address maker,uint256 traits,bytes data)) view returns(bytes32)",
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
const current = await read(market.maker, "currentAquaHash", [
  market.stableStrategyId,
]);
const cls = (await read(market.maker, "strategyClassId", [
  market.stableStrategyId,
])) as bigint;
if (
  !same(current, market.currentAquaHash) ||
  cls.toString() !== market.classId ||
  cls > BigInt(Number.MAX_SAFE_INTEGER)
)
  throw new Error("Strategy changed during discovery");
if (
  !same(await read(market.maker, "aqua"), market.aqua) ||
  !same(await read(market.maker, "aquaSwapVMRouter"), market.router)
)
  throw new Error("Maker binding mismatch");
if (
  !same(
    await read(market.router, "hash", [
      { ...market.order, traits: BigInt(market.order.traits) },
    ]),
    current,
  )
)
  throw new Error("Order bytes do not match current onchain hash");
const tokens = [getAddress(market.token0), getAddress(market.token1)].sort(
  (a, b) => (BigInt(a) < BigInt(b) ? -1 : 1),
) as [Address, Address];
const registry = (await read(market.maker, "registry")) as Address;
const backing: Array<{
  token: Address;
  vault: Address;
  available: string;
  freePrincipal: string;
  cap: string;
  committers: number;
}> = [];
for (const token of tokens) {
  if ((await read(token, "decimals")) !== 6)
    throw new Error("Token decimals changed");
  const vault = (await read(registry, "vaultForAsset", [token])) as Address;
  if (same(vault, zeroAddress)) throw new Error("Missing production vault");
  const available = (await read(vault, "availableFor", [cls])) as bigint;
  const lps = (await read(vault, "committersOf", [cls])) as Address[];
  if (
    lps.length > 256 ||
    new Set(lps.map((x) => x.toLowerCase())).size !== lps.length
  )
    throw new Error("Unbounded or duplicate committer set");
  let free = 0n;
  for (const lp of lps)
    free += (await read(vault, "freePrincipal", [lp])) as bigint;
  const cap = available < free ? available : free;
  if (cap <= 0n) throw new Error("No current free physical principal");
  backing.push({
    token,
    vault,
    available: String(available),
    freePrincipal: String(free),
    cap: String(cap),
    committers: lps.length,
  });
}
let external:
  | { pool: Address; fee: number; quoter: Address; factory: Address }
  | undefined;
for (const venue of chain.venues.filter((v) => v.name === "uniswap-v3")) {
  for (const fee of venue.fees) {
    const pool = (await read(venue.factory, "getPool", [
      ...tokens,
      fee,
    ])) as Address;
    if (same(pool, zeroAddress)) continue;
    if (
      !same(await read(pool, "factory"), venue.factory) ||
      !same(await read(pool, "token0"), tokens[0]) ||
      !same(await read(pool, "token1"), tokens[1])
    )
      throw new Error("External pool binding mismatch");
    if ((await read(pool, "liquidity")) > 0n) {
      external = { pool, fee, quoter: venue.quoter, factory: venue.factory };
      break;
    }
  }
  if (external) break;
}
if (!external) throw new Error("No liquid reviewed external pool");
const code = await rpc.getCode({
  address: market.maker,
  blockNumber: block.number,
});
if (!code || code === "0x") throw new Error("Missing maker code");
if ((await rpc.getBlock({ blockNumber: block.number })).hash !== block.hash)
  throw new Error("Snapshot block reorganized");
const config = {
  chainId: chain.chainId,
  block: Number(block.number),
  blockHash: block.hash,
  router: market.router,
  aqua: market.aqua,
  maker: market.maker,
  strategyId: market.stableStrategyId,
  orderHash: current,
  classId: Number(cls),
  token0: tokens[0],
  token1: tokens[1],
  traits: market.order.traits,
  program: market.order.data,
  slices: market.slices,
  externalPool: external.pool,
  externalFactory: external.factory,
  externalFee: external.fee,
  quoter: external.quoter,
  universalRouter: chain.universalRouter,
  permit2: chain.permit2,
  hook: chain.aqua0Hook,
  makerCodeHash: keccak256(code),
  backing,
  capturedAt: new Date().toISOString(),
  publicTransactions: 0,
};
writeFileSync(values.output!, JSON.stringify(config, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      output: values.output,
      chainId: config.chainId,
      block: config.block,
      strategyId: config.strategyId,
      backing,
      external,
      publicTransactions: 0,
    },
    null,
    2,
  ),
);
