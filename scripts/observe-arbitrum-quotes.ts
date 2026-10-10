import { readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  http,
  parseAbi,
  formatUnits,
  getAddress,
  type Address,
  type Hex,
} from "viem";

// Diagnostic read-only probe of one owner-captured market, not the worker's sizing algorithm.
// Every quote uses one canonical block and the intended executor caller. No account is created.
const source = JSON.parse(
  readFileSync("config/production-maker-arbitrum-fork.json", "utf8"),
);
const launch = JSON.parse(
  readFileSync("../evidence/arbitrum-unsigned-launch-20260929.json", "utf8"),
);
if (source.chainId !== 42161 || launch.chainId !== 42161)
  throw new Error("Arbitrum fixture is required");
const rpc = createPublicClient({
  transport: http("https://arb1.arbitrum.io/rpc", {
    timeout: 12000,
    retryCount: 0,
  }),
});
if ((await rpc.getChainId()) !== 42161) throw new Error("RPC chain mismatch");
const block = await rpc.getBlock(),
  caller = getAddress(launch.predictedExecutor);
const abi = parseAbi([
  "function currentAquaHash(bytes32) view returns(bytes32)",
  "function availableFor(uint256) view returns(uint256)",
  "function committersOf(uint256) view returns(address[])",
  "function freePrincipal(address) view returns(uint256)",
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function factory() view returns(address)",
  "function fee() view returns(uint24)",
  "function quote((address maker,uint256 traits,bytes data),address,address,uint256,bytes) view returns(uint256,uint256,bytes32)",
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
    account: caller,
    blockNumber: block.number,
  } as never) as Promise<any>;
if (
  (
    await read(source.maker, "currentAquaHash", [source.strategyId])
  ).toLowerCase() !== source.orderHash.toLowerCase()
)
  throw new Error(
    "Production strategy has changed; refresh capture rather than reuse stale program",
  );
const identities = await Promise.all([
  read(source.externalPool, "token0"),
  read(source.externalPool, "token1"),
  read(source.externalPool, "factory"),
  read(source.externalPool, "fee"),
]);
if (
  getAddress(identities[0]) !== getAddress(source.token0) ||
  getAddress(identities[1]) !== getAddress(source.token1) ||
  getAddress(identities[2]) !== getAddress(source.externalFactory) ||
  identities[3] !== source.externalFee
)
  throw new Error("External pool identity mismatch");
const caps = new Map<string, bigint>();
for (const b of source.backing) {
  const available = (await read(b.vault, "availableFor", [
    BigInt(source.classId),
  ])) as bigint;
  const lps = (await read(b.vault, "committersOf", [
    BigInt(source.classId),
  ])) as Address[];
  if (
    lps.length > 256 ||
    new Set(lps.map((x) => x.toLowerCase())).size !== lps.length
  )
    throw new Error("Invalid committer set");
  let free = 0n;
  for (const lp of lps)
    free += (await read(b.vault, "freePrincipal", [lp])) as bigint;
  caps.set(b.token.toLowerCase(), free < available ? free : available);
}
const order = {
  maker: source.maker,
  traits: BigInt(source.traits),
  data: source.program,
};
const taker = `0x${"00".repeat(source.slices * 2)}0041` as Hex;
async function vm(input: Address, output: Address, amount: bigint) {
  const [used, out, hash] = await read(source.router, "quote", [
    order,
    input,
    output,
    amount,
    taker,
  ]);
  if (
    used !== amount ||
    hash.toLowerCase() !== source.orderHash.toLowerCase() ||
    out <= 0n ||
    out > (caps.get(output.toLowerCase()) ?? 0n)
  )
    throw new Error("VM quote lacks a full current backed fill");
  return out as bigint;
}
async function v3(input: Address, output: Address, amount: bigint) {
  const result = await rpc.simulateContract({
    address: source.quoter,
    abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: input,
        tokenOut: output,
        amountIn: amount,
        fee: source.externalFee,
        sqrtPriceLimitX96: 0n,
      },
    ],
    account: caller,
    blockNumber: block.number,
  });
  return result.result[0];
}
const rows: unknown[] = [];
let positive = 0,
  failed = 0;
for (const amount of [1_000_000n, 2_000_000n, 5_000_000n]) {
  for (const aquaFirst of [true, false]) {
    try {
      const middle = aquaFirst
        ? await vm(source.token0, source.token1, amount)
        : await v3(source.token0, source.token1, amount);
      const end = aquaFirst
        ? await v3(source.token1, source.token0, middle)
        : await vm(source.token1, source.token0, middle);
      if (end > amount) positive++;
      rows.push({
        aquaFirst,
        inputUsdc: formatUnits(amount, 6),
        intermediateRaw: String(middle),
        finalUsdc: formatUnits(end, 6),
        grossProfitUsdc: formatUnits(end - amount, 6),
        netProfit: null,
        fullTransactionSimulated: false,
      });
    } catch (error) {
      failed++;
      rows.push({
        aquaFirst,
        inputUsdc: formatUnits(amount, 6),
        unavailable: true,
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}
if ((await rpc.getBlock({ blockNumber: block.number })).hash !== block.hash)
  throw new Error("Canonical snapshot changed");
const report = {
  observedAt: new Date().toISOString(),
  chainId: 42161,
  blockNumber: String(block.number),
  blockHash: block.hash,
  market: source.strategyId,
  externalPool: source.externalPool,
  caller,
  rows,
  positiveGrossSamples: positive,
  unavailableSamples: failed,
  qualification:
    "Read-only quotes for one actual current market at 1, 2 and 5 USDC. This is not an exhaustive opportunity search, a full transaction simulation, or a net-of-gas profitability proof. No synthetic displacement was applied.",
  publicTransactions: 0,
};
writeFileSync(
  "../evidence/arbitrum-live-quote-observation-20260929.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
