import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockNotFoundError, type Hex, type PublicClient } from "viem";
import { loadChains, settingsSchema, type ChainConfig } from "../src/config.js";
import { Runner } from "../src/runner.js";
import { Journal } from "../src/state.js";
import { ObsoleteScan } from "../src/head-scheduler.js";
import type { AquaClient } from "../src/aqua.js";
import type { Candidate } from "../src/strategy.js";

const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const usdc = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const dai = "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1";
const poolId =
  "0x1f7d6bb891093beb90fb3802388282e1d2fea68118c3220d902c7a8e207b5f15";
const externalAddress = "0x7CF803e8d82A50504180f417B8bC7a493C0a0503";

function fixture(expired = false, selectedBoundary = false) {
  const dir = mkdtempSync(join(tmpdir(), "v4-rpc-alignment-"));
  const source = loadChains().find((c) => c.chainId === 42161)!;
  const pool = {
    poolId,
    currency0: usdc,
    currency1: dai,
    fee: 100,
    tickSpacing: 1,
    hooks: source.aqua0Hook,
  } as const;
  const chain: ChainConfig = {
    ...source,
    pools: [pool],
    venues: [{ ...source.venues[0]!, fees: [100] }],
  };
  const fee = {
    maxGasUnits: "2000000",
    maxFeePerGas: "50000000",
    l1FeeReserveWei: "0",
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    gasConversionFee: 100,
  };
  const settings = settingsSchema.parse({
    apiUrl: "https://example.invalid",
    mode: selectedBoundary ? "execute" : "observe",
    networkMode: "fork",
    markets: [
      {
        chainId: 42161,
        poolId,
        classId: "14",
        baseToken: usdc,
        amounts: [],
        minNetProfit: "10000",
        maxInput: "5000000",
      },
    ],
    quoteFees: { 42161: fee },
    execution: {
      42161: {
        ...fee,
        executor: source.universalRouter,
        operator: source.universalRouter,
        privateKeyEnv: "NEVER_SET_OFFLINE",
        allowBroadcast: selectedBoundary,
        maxDailyGasWei: "1000000000000",
      },
    },
    scheduling: { headerPollMs: 100 },
  });
  const market = settings.markets[0]!;
  const external = {
    address: externalAddress,
    fee: 100,
    venue: chain.venues[0]!,
  } as const;
  let quoteReturned = false,
    observedHead = 100n,
    catchupReads = 0,
    authorizations = 0;
  const boundary = new Error("OFFLINE_STOP_BEFORE_AUTHORIZATION_OR_SIGNING");
  const candidate = (): Candidate => ({
    quotedAt: Date.now() - (expired ? settings.maxQuoteAgeMs + 1 : 0),
    blockNumber: 102n,
    quoteBlockHash: hash(102),
    aquaFirst: false,
    quotedProfit: 30000n,
    netProfit: 30000n,
    minimumNetProfit: 10000n,
    trade: {
      id: hash(501),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 90),
      validUntilBlock: 104n,
      minProfit: 10000n,
      first: {
        venue: 1,
        target: externalAddress,
        tokenIn: usdc,
        tokenOut: dai,
        amountIn: 1000000n,
        minOut: 10n ** 18n,
        pool,
        hookData: "0x",
      },
      second: {
        venue: 0,
        target: chain.universalRouter,
        tokenIn: dai,
        tokenOut: usdc,
        amountIn: 10n ** 18n,
        minOut: 1030000n,
        pool,
        hookData: "0x",
      },
    },
  });
  const client = {
    getChainId: async () => 42161,
    getCode: async () => "0x6000",
    getBlockNumber: async () => 101n,
    getBlock: async (args?: { blockNumber?: bigint }) => {
      if (args?.blockNumber !== undefined) {
        if (args.blockNumber > observedHead)
          throw new BlockNotFoundError({ blockNumber: args.blockNumber });
        return {
          number: args.blockNumber,
          hash: hash(Number(args.blockNumber)),
          timestamp: BigInt(Math.floor(Date.now() / 1000)),
        };
      }
      if (quoteReturned) observedHead = ++catchupReads === 1 ? 101n : 102n;
      return {
        number: observedHead,
        hash: hash(Number(observedHead)),
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
      };
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "poolManager":
          return chain.poolManager;
        case "getPool":
          return externalAddress;
        case "token0":
          return usdc;
        case "token1":
          return dai;
        case "fee":
          return 100;
        case "liquidity":
          return 1n;
        case "balanceOf":
          return 5000000n;
        case "limits":
          return [5000000n, 10000n];
        default:
          throw new Error(`Unexpected offline contract read: ${functionName}`);
      }
    },
  } as unknown as PublicClient;
  const aqua = {
    searchStatus: () => ({
      active: 0,
      queued: 0,
      limit: 4,
      perChainLimit: 2,
      selectedTradeChecksQueued: 0,
    }),
    optimize: async () => {
      quoteReturned = true;
      return {
        candidates: [candidate()],
        blockNumber: 102n,
        searches: [{ curveEvaluations: 1 }],
        excluded: [],
      };
    },
    authorize: async () => {
      authorizations++;
      throw boundary;
    },
  } as unknown as AquaClient;
  class OfflineRunner extends Runner {
    override client() {
      return client;
    }
  }
  const runner = new OfflineRunner(
    [chain],
    settings,
    aqua,
    new Journal(join(dir, "journal.json")),
  );
  return {
    runner,
    chain,
    client,
    settings,
    boundary,
    market,
    pool,
    external,
    candidate,
    catchupReads: () => catchupReads,
    authorizations: () => authorizations,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("V4 discovery waits for the real RPC head before rejecting a subsecond-old quote as future", async () => {
  const f = fixture();
  try {
    await f.runner.scanLatest(42161);
    assert.equal(f.runner.metrics.candidates, 1);
    assert.equal(f.runner.metrics.errors, 0);
    assert.equal(f.runner.metrics.submitted, 0);
    assert.equal(
      f.authorizations(),
      0,
      "Observe-only regression must never authorize",
    );
    assert.equal(f.catchupReads(), 2);
  } finally {
    f.cleanup();
  }
});

test("the chosen V4 re-quote catches up before requesting its block hash or JIT authorization", async () => {
  // In-memory execution-mode fixture stops BEFORE authorization; no key or RPC transport exists.
  const f = fixture(false, true);
  try {
    const choice = {
      kind: "v4",
      startToken: usdc,
      candidate: f.candidate(),
      market: f.market,
      pool: f.pool,
      external: f.external,
    };
    const runner = f.runner as unknown as {
      executePricedChoice(
        chain: ChainConfig,
        client: PublicClient,
        choice: unknown,
      ): Promise<boolean>;
    };
    await assert.rejects(
      () => runner.executePricedChoice(f.chain, f.client, choice),
      (e: unknown) => e === f.boundary,
    );
    assert.equal(f.catchupReads(), 2);
    assert.equal(
      f.authorizations(),
      1,
      "Only the offline sentinel boundary is called",
    );
    assert.equal(f.runner.metrics.submitted, 0);
    assert.equal(process.env.NEVER_SET_OFFLINE, undefined);
  } finally {
    f.cleanup();
  }
});

test("an expired V4 quote is discarded without inflating the chain failure circuit", async () => {
  const f = fixture(true);
  try {
    await assert.rejects(() => f.runner.scanLatest(42161), ObsoleteScan);
    assert.equal(f.runner.metrics.candidates, 0);
    assert.equal(f.runner.metrics.errors, 0);
    assert.equal(f.runner.reportingStatus().chains[0]!.retryAt, null);
    assert.equal(f.authorizations(), 0);
  } finally {
    f.cleanup();
  }
});
