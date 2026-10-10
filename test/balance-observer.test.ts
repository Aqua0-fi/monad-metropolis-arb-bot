import test from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import {
  sampleBalances,
  configuredBalanceTargets,
} from "../src/balance-observer.js";
import { loadChains, settingsSchema } from "../src/config.js";
const chain = loadChains().find((c) => c.chainId === 42161)!;
const wallet = "0x1111111111111111111111111111111111111111",
  asset = "0x2222222222222222222222222222222222222222";
const hash = `0x${"ab".repeat(32)}` as const;
const target = { role: "executor" as const, wallet, asset };
function harness() {
  const reads: Record<string, unknown>[] = [];
  const client = {
    getChainId: async () => 42161,
    getBlock: async (p?: unknown) => {
      reads.push({ method: "getBlock", p });
      return { number: 100n, hash, timestamp: 1790660000n };
    },
    getBalance: async (p: Record<string, unknown>) => {
      reads.push(p);
      return 0n;
    },
    readContract: async (p: Record<string, unknown>) => {
      reads.push(p);
      return p.functionName === "decimals"
        ? 6
        : p.functionName === "symbol"
          ? "USDC"
          : 5704396n;
    },
  } as unknown as PublicClient;
  return { reads, client };
}

test("wallet balances and token units come from the same canonical block, with native zero kept as real zero", async () => {
  const h = harness();
  const rows = await sampleBalances(
    h.client,
    chain,
    "mainnet",
    [target, { role: "operator", wallet, asset: null }],
    () => 1790661000000,
  );
  assert.equal(rows[0]!.amount, "5704396");
  assert.equal(rows[0]!.symbol, "USDC");
  assert.equal(rows[0]!.decimals, 6);
  assert.equal(rows[1]!.amount, "0");
  assert.equal(rows[1]!.symbol, "ETH");
  assert.equal(rows[1]!.decimals, 18);
  assert.equal(rows[0]!.blockHash, hash);
  assert.equal(rows[0]!.blockNumber, "100");
  for (const read of h.reads.filter((x) => x.functionName || x.address))
    assert.equal(read.blockNumber, 100n);
});

test("missing token metadata, RPC errors and reorgs become explicit gaps rather than assumed balances", async () => {
  for (const mode of ["metadata", "rpc", "reorg"]) {
    const h = harness();
    let blocks = 0;
    const client = {
      ...h.client,
      ...(mode === "metadata"
        ? {
            readContract: async () => {
              throw Error("private provider URL");
            },
          }
        : {}),
      ...(mode === "rpc"
        ? {
            getChainId: async () => {
              throw Error("unavailable");
            },
          }
        : {}),
      ...(mode === "reorg"
        ? {
            getBlock: async () => ({
              number: 100n,
              hash: ++blocks === 1 ? hash : `0x${"cd".repeat(32)}`,
              timestamp: 1790660000n,
            }),
          }
        : {}),
    } as unknown as PublicClient;
    const rows = await sampleBalances(client, chain, "mainnet", [target]);
    assert.equal(rows[0]!.amount, null);
    assert(rows[0]!.issue);
    assert(!rows[0]!.issue!.includes("private"));
  }
});

test("targets derive only from the configured wallets and known assets, never from supplied free-form RPC data", () => {
  const settings = settingsSchema.parse({
    apiUrl: "http://127.0.0.1:1",
    execution: {
      42161: {
        executor: wallet,
        operator: asset,
        privateKeyEnv: "unused",
        allowBroadcast: false,
        maxGasUnits: "1",
        maxFeePerGas: "1",
        l1FeeReserveWei: "0",
        maxDailyGasWei: "1",
        wrappedNative: chain.pools[0]!.currency0,
        gasConversionFee: 100,
      },
    },
  });
  const targets = configuredBalanceTargets(chain, settings);
  assert(targets.some((x) => x.role === "operator" && x.asset === null));
  assert(
    targets.some(
      (x) =>
        x.role === "executor" &&
        x.asset === chain.pools[0]!.currency1.toLowerCase(),
    ),
  );
  assert(targets.every((x) => [wallet, asset].includes(x.wallet)));
  assert.deepEqual(
    configuredBalanceTargets({ ...chain, chainId: 1 }, settings),
    [],
  );
});
