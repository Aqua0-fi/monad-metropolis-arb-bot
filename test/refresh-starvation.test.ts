import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import type { Hex, PublicClient } from "viem";
import { loadChains, settingsSchema } from "../src/config.js";
import {
  LatestHeadScheduler,
  ObsoleteScan,
  type ScanTask,
} from "../src/head-scheduler.js";
import {
  refreshSwapVMChoice,
  type SwapVMChoice,
} from "../src/swapvm-search.js";
import {
  acceptSwapVMOptimization,
  swapVMMarketSchema,
  type SwapVMSizingRequest,
} from "../src/swapvm.js";
import type { AquaClient } from "../src/aqua.js";
import type { SwapVMMarketCatalog } from "../src/swapvm-catalog.js";
import type { MarketPolicy } from "../src/market-catalog.js";
import { Runner } from "../src/runner.js";
import { Journal } from "../src/state.js";
import { HistoryStore } from "../src/history.js";

const seed = JSON.parse(
  readFileSync("config/observed-opportunity-arbitrum-fork.json", "utf8"),
).quote;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const head = (n: number) => ({
  number: BigInt(n),
  hash: hash(n),
  parentHash: hash(n - 1),
});
function fixture() {
  const source = loadChains().find((c) => c.chainId === 42161)!;
  const chain = {
    ...source,
    venues: [{ ...source.venues[0]!, fees: [seed.externalFee] }],
  };
  const market = swapVMMarketSchema.parse({
    ...seed.market,
    blockNumber: "100",
    blockHash: hash(100),
  });
  const policy: MarketPolicy = {
    approved: true,
    classId: "1",
    baseToken: seed.baseToken,
    amounts: [],
    maxInput: "5000000",
    minNetProfit: "10000",
    note: "offline regression",
    version: 1,
    actor: "test",
    updatedAt: new Date().toISOString(),
  };
  const settings = settingsSchema.parse({
    apiUrl: "http://127.0.0.1:1",
    mode: "execute",
    networkMode: "fork",
    execution: {
      42161: {
        executor: seed.caller,
        operator: seed.caller,
        privateKeyEnv: "NEVER_USED_OFFLINE",
        allowBroadcast: true,
        maxGasUnits: "2000000",
        maxFeePerGas: "50000000",
        l1FeeReserveWei: "0",
        maxDailyGasWei: "1000000000000",
        wrappedNative: market.token0,
        gasConversionFee: 100,
      },
    },
  });
  const external = {
    address: seed.externalPool,
    fee: seed.externalFee,
    venue: chain.venues[0]!,
  };
  const request: SwapVMSizingRequest = {
    chain,
    market,
    policy,
    external,
    network: "fork",
    caller: seed.caller,
    maxInput: 5000000n,
    gasBudget: 0n,
    slippageBps: 10,
  };
  const result = (n: number, r = request) =>
    acceptSwapVMOptimization(
      {
        ...seed,
        network: "fork",
        gasBudget: "0",
        blockNumber: String(n),
        blockHash: hash(n),
        blockTimestamp: String(Math.floor(Date.now() / 1000)),
        market: { ...seed.market, blockNumber: String(n), blockHash: hash(n) },
        candidates: seed.candidates.map((c: Record<string, unknown>) => ({
          ...c,
          netProfit: c.grossProfit,
        })),
      },
      r,
      Date.now(),
    );
  let current = 100;
  let balance = 5000000n;
  const client = {
    getChainId: async () => 42161,
    getCode: async () => "0x6000",
    getBlock: async (p?: { blockNumber?: bigint }) => ({
      ...head(Number(p?.blockNumber ?? current)),
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
    }),
    getBlockNumber: async () => BigInt(current),
    readContract: async (p: { functionName: string }) => {
      switch (p.functionName) {
        case "balanceOf":
          return balance;
        case "limits":
          return [5000000n, 10000n];
        case "poolManager":
          return chain.poolManager;
        case "getPool":
          return external.address;
        case "token0":
          return market.token0;
        case "token1":
          return market.token1;
        case "fee":
          return external.fee;
        case "liquidity":
          return 1n;
        default:
          throw Error(`Unexpected offline read ${p.functionName}`);
      }
    },
  } as unknown as PublicClient;
  const catalog = {
    list: () => ({ markets: [{ market, policy, readyToQuote: true }] }),
    assertApproved: () => {},
  } as unknown as SwapVMMarketCatalog;
  const choice: SwapVMChoice = {
    kind: "aqua",
    candidate: result(100).candidates[0]!,
    startToken: seed.baseToken,
    market,
    policy,
    external,
    inputCap: 5000000n,
  };
  return {
    chain,
    settings,
    client,
    catalog,
    choice,
    result,
    setHead: (n: number) => {
      current = n;
    },
    setBalance: (n: bigint) => {
      balance = n;
    },
  };
}

async function heldTask(
  run: (task: ScanTask, advance: (n: number) => void) => Promise<void>,
) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let task!: ScanTask;
  const scheduler = new LatestHeadScheduler({
    maxConcurrent: 1,
    maxBlockLag: 8,
    maxTaskMs: 8000,
    run: async (_, t) => {
      task = t;
      await held;
    },
  });
  scheduler.notify(42161, head(100));
  await turn();
  try {
    await run(task, (n) => scheduler.notify(42161, head(n)));
  } finally {
    const stopped = scheduler.stop();
    release();
    await stopped;
  }
}

test("a returned fresh quote replaces an aged search anchor before the old quote check can discard it", async () => {
  await heldTask(async (task, advance) => {
    const f = fixture();
    let actualRequest: SwapVMSizingRequest | undefined;
    const aqua = {
      optimizeSwapVM: async (r: SwapVMSizingRequest) => {
        actualRequest = r;
        for (let n = 101; n <= 112; n++) advance(n);
        f.setHead(112);
        return f.result(111, r);
      },
    } as unknown as AquaClient;
    const answer = await refreshSwapVMChoice(
      {
        ...f,
        aqua,
        check: () => task.assertCurrent(),
        bindSnapshot: task.adoptQuote,
        onEvent: () => {},
      },
      f.choice,
    );
    assert(answer);
    assert.equal(answer.blockNumber, 111n);
    assert.equal(
      actualRequest?.fixedAmount,
      f.choice.candidate.trade.first.amountIn,
      "refresh the already-selected size instead of repeating the entire search",
    );
    assert.doesNotThrow(() => task.assertCurrent());
    assert.throws(
      () => task.bindSnapshot(111n, hash(111)),
      /changed/,
      "a provisional re-quote does not authorize signing on old final state",
    );
  });
});

test("insufficient current inventory rejects the chosen size without guessing another size in the execution lane", async () => {
  const f = fixture();
  f.setBalance(1n);
  let requests = 0;
  const aqua = {
    optimizeSwapVM: async () => {
      requests++;
      return f.result(100);
    },
  } as unknown as AquaClient;
  const result = await refreshSwapVMChoice(
    { ...f, aqua, onEvent: () => {} },
    f.choice,
  );
  assert.equal(result, null);
  assert.equal(requests, 0);
});

test("a chosen direction is not silently replaced by another route direction during refresh", async () => {
  const f = fixture();
  const aqua = {
    optimizeSwapVM: async () => ({
      candidates: [
        { ...f.choice.candidate, aquaFirst: !f.choice.candidate.aquaFirst },
      ],
    }),
  } as unknown as AquaClient;
  assert.equal(
    await refreshSwapVMChoice({ ...f, aqua, onEvent: () => {} }, f.choice),
    null,
  );
});

test("expired, reorged and stopped tasks cannot adopt new quotes to revive themselves", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let task!: ScanTask;
  let now = 0;
  const s = new LatestHeadScheduler({
    maxConcurrent: 1,
    maxBlockLag: 8,
    maxTaskMs: 1000,
    now: () => now,
    run: async (_, t) => {
      task = t;
      await held;
    },
  });
  s.notify(42161, head(100));
  await turn();
  try {
    now = 1001;
    assert.throws(
      () => task.adoptQuote(100n, hash(100)),
      /expired|budget|obsolete/i,
    );
    assert.throws(
      () => task.bindSnapshot(100n, hash(100)),
      /expired|budget|obsolete/i,
    );
  } finally {
    const stop = s.stop();
    release();
    await stop;
  }
  assert.throws(() => task.adoptQuote(100n, hash(100)), /obsolete|stopped/i);
});

test("a found candidate remains counted when its mandatory recheck is discarded; no signer is reached", async () => {
  const f = fixture(),
    dir = mkdtempSync(join(tmpdir(), "refresh-counter-"));
  const history = new HistoryStore(":memory:");
  let requests = 0;
  const aqua = {
    optimizeSwapVM: async (r: SwapVMSizingRequest) => {
      if (++requests === 2)
        throw new ObsoleteScan("fixture changed during refresh");
      return f.result(100, r);
    },
    searchStatus: () => ({
      active: 0,
      queued: 0,
      limit: 4,
      perChainLimit: 2,
      selectedTradeChecksQueued: 0,
    }),
  } as unknown as AquaClient;
  class OfflineRunner extends Runner {
    override client() {
      return f.client;
    }
  }
  const runner = new OfflineRunner(
    [f.chain],
    f.settings,
    aqua,
    new Journal(join(dir, "journal.json")),
    history,
    undefined,
    f.catalog,
  );
  try {
    await assert.rejects(() => runner.scanLatest(42161), ObsoleteScan);
    assert.equal(requests, 2);
    assert.equal(runner.metrics.candidates, 1);
    assert.equal(runner.metrics.submitted, 0);
    assert.equal(history.list({ network: "fork", limit: 5 }).matchedCount, 0);
  } finally {
    history.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a complete scan can adopt a fresh result after its original anchor ages on a fast chain", async () => {
  const f = fixture(),
    dir = mkdtempSync(join(tmpdir(), "fast-read-lane-"));
  const observed = { ...f.settings, mode: "observe" as const };
  let moved = false;
  let scheduler: LatestHeadScheduler;
  const aqua = {
    optimizeSwapVM: async (r: SwapVMSizingRequest) => {
      if (!moved) {
        moved = true;
        for (let n = 101; n <= 112; n++) scheduler.notify(42161, head(n));
        f.setHead(112);
      }
      return f.result(111, r);
    },
    searchStatus: () => ({
      active: 0,
      queued: 0,
      limit: 4,
      perChainLimit: 2,
      selectedTradeChecksQueued: 0,
    }),
  } as unknown as AquaClient;
  class OfflineRunner extends Runner {
    override client() {
      return f.client;
    }
  }
  const runner = new OfflineRunner(
    [f.chain],
    observed,
    aqua,
    new Journal(join(dir, "journal.json")),
    undefined,
    undefined,
    f.catalog,
  );
  scheduler = new LatestHeadScheduler({
    maxConcurrent: 1,
    maxBlockLag: 8,
    maxTaskMs: 8000,
    run: (id, t) => runner.scanLatest(id, t),
  });
  try {
    scheduler.notify(42161, head(100));
    await scheduler.drain();
    assert(scheduler.status()[0]!.completed > 0);
    assert.equal(scheduler.status()[0]!.discarded, 0);
    assert(runner.metrics.candidates > 0);
    assert.equal(runner.metrics.submitted, 0);
    assert(runner.metrics.lastSuccess > 0);
  } finally {
    await scheduler.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a genuinely stale or reorganized returned quote cannot be adopted", async () => {
  for (const reorganized of [false, true]) {
    const f = fixture();
    f.setHead(reorganized ? 101 : 112);
    const base = f.client;
    const client = reorganized
      ? ({
          ...base,
          getBlock: async () => ({ ...head(101), hash: hash(999) }),
        } as unknown as PublicClient)
      : base;
    let adopted = false;
    const aqua = {
      optimizeSwapVM: async () => f.result(100),
    } as unknown as AquaClient;
    await assert.rejects(
      () =>
        refreshSwapVMChoice(
          {
            ...f,
            client,
            aqua,
            bindSnapshot: () => {
              adopted = true;
            },
            onEvent: () => {},
          },
          f.choice,
        ),
      /stale|reorg/i,
    );
    assert.equal(adopted, false);
  }
});

test("liveness is independent of old quote age but cannot survive revocation, stop or the task time budget", async () => {
  await heldTask(async (task, advance) => {
    for (let n = 101; n <= 112; n++) advance(n);
    assert.doesNotThrow(() => task.assertActive());
    assert.throws(() => task.assertCurrent());
    advance(100);
    assert.throws(() => task.assertActive(), /obsolete|invalidated/i);
    assert.throws(
      () => task.adoptQuote(100n, hash(100)),
      /obsolete|invalidated/i,
    );
  });
});

test("a completed execution proof uses the existing block bound while raw quotes cannot claim latest-state binding", async () => {
  await heldTask(async (task, advance) => {
    for (let n = 101; n <= 112; n++) advance(n);
    assert.throws(() => task.bindSnapshot(111n, hash(111)), /changed/i);
    assert.doesNotThrow(() => task.bindExecutionSnapshot(111n, hash(111)));
    assert.doesNotThrow(() => task.assertCurrent());
    assert.throws(() => task.bindExecutionSnapshot(103n, hash(103)), /bounds/i);
    assert.throws(() => task.bindExecutionSnapshot(112n, hash(999)), /bounds/i);
    advance(100);
    assert.throws(
      () => task.bindExecutionSnapshot(100n, hash(100)),
      /invalidated/i,
    );
  });
});

test("failed SwapVM searches are reported as failures, not successful empty scans, and diagnostics redact URLs", async () => {
  const f = fixture(),
    dir = mkdtempSync(join(tmpdir(), "failed-swapvm-"));
  const aqua = {
    optimizeSwapVM: async () => {
      throw Error("Provider failed https://rpc.example/private-key");
    },
    searchStatus: () => ({
      active: 0,
      queued: 0,
      limit: 4,
      perChainLimit: 2,
      selectedTradeChecksQueued: 0,
    }),
  } as unknown as AquaClient;
  class OfflineRunner extends Runner {
    override client() {
      return f.client;
    }
  }
  const runner = new OfflineRunner(
    [f.chain],
    { ...f.settings, mode: "observe" },
    aqua,
    new Journal(join(dir, "journal.json")),
    undefined,
    undefined,
    f.catalog,
  );
  try {
    await assert.rejects(() => runner.scanLatest(42161), /Quote failures/);
    assert.equal(runner.metrics.errors, 1);
    assert.equal(runner.metrics.lastSuccess, 0);
    const activity = JSON.stringify(runner.reportingStatus().recentActivity);
    assert(!activity.includes("private-key"));
    assert(activity.includes("RPC or API URL"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refresh waits for a lagging provider before canonical validation instead of throwing a false reorg", async () => {
  const f = fixture();
  f.settings.scheduling.headerPollMs = 100;
  let quoteReturned = false,
    laggingReads = 0;
  const underlying = f.client.getBlock;
  const client = {
    ...f.client,
    getBlock: async (p?: { blockNumber?: bigint }) => {
      if (p?.blockNumber !== undefined) return underlying(p as never);
      if (!quoteReturned)
        return {
          ...head(100),
          timestamp: BigInt(Math.floor(Date.now() / 1000)),
        };
      laggingReads++;
      return {
        ...head(laggingReads === 1 ? 100 : 102),
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
      };
    },
  } as unknown as PublicClient;
  const aqua = {
    optimizeSwapVM: async (r: SwapVMSizingRequest) => {
      quoteReturned = true;
      return f.result(102, r);
    },
  } as unknown as AquaClient;
  const answer = await refreshSwapVMChoice(
    { ...f, client, aqua, onEvent: () => {} },
    f.choice,
  );
  assert(answer);
  assert.equal(answer.blockNumber, 102n);
  assert.equal(laggingReads, 2);
});

test("failed scans do not inflate the scheduler's successful completion counter", async () => {
  const f = fixture(),
    dir = mkdtempSync(join(tmpdir(), "failed-completion-"));
  const aqua = {
    optimizeSwapVM: async () => {
      throw Error("RPC unavailable");
    },
    searchStatus: () => ({
      active: 0,
      queued: 0,
      limit: 4,
      perChainLimit: 2,
      selectedTradeChecksQueued: 0,
    }),
  } as unknown as AquaClient;
  class OfflineRunner extends Runner {
    override client() {
      return f.client;
    }
  }
  const runner = new OfflineRunner(
    [f.chain],
    { ...f.settings, mode: "observe" },
    aqua,
    new Journal(join(dir, "journal.json")),
    undefined,
    undefined,
    f.catalog,
  );
  const scheduler = new LatestHeadScheduler({
    maxConcurrent: 1,
    maxBlockLag: 8,
    maxTaskMs: 8000,
    run: (id, t) => runner.scanLatest(id, t),
  });
  try {
    scheduler.notify(42161, head(100));
    await scheduler.drain();
    assert.equal(scheduler.status()[0]!.completed, 0);
    assert.equal(scheduler.status()[0]!.failures, 1);
    assert.equal(runner.metrics.lastSuccess, 0);
  } finally {
    await scheduler.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a discovered candidate remains in durable history when the mandatory refresh becomes stale", async () => {
  const { ObservationStore } = await import("../src/observations.js");
  const f = fixture(),
    dir = mkdtempSync(join(tmpdir(), "durable-opportunity-")),
    history = new HistoryStore(":memory:"),
    observations = new ObservationStore(":memory:");
  let requests = 0;
  const aqua = {
    optimizeSwapVM: async (r: SwapVMSizingRequest) => {
      if (++requests === 2) throw new ObsoleteScan("changed while refreshing");
      return f.result(100, r);
    },
    searchStatus: () => ({
      active: 0,
      queued: 0,
      limit: 4,
      perChainLimit: 2,
      selectedTradeChecksQueued: 0,
    }),
  } as unknown as AquaClient;
  class OfflineRunner extends Runner {
    override client() {
      return f.client;
    }
  }
  const runner = new OfflineRunner(
    [f.chain],
    f.settings,
    aqua,
    new Journal(join(dir, "journal.json")),
    history,
    undefined,
    f.catalog,
    undefined,
    observations,
  );
  try {
    await assert.rejects(() => runner.scanLatest(42161), ObsoleteScan);
    const page = observations.opportunities({ network: "fork" });
    assert.equal(page.matchedCount, 1);
    assert.equal(page.items[0]!.state, "stale");
    assert.equal(page.items[0]!.estimatedNet, null);
    assert.equal(page.items[0]!.transactionHash, null);
  } finally {
    history.close();
    observations.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an idle chain with no quoteable approved market is not reported as a completed price search", async () => {
  const f = fixture(),
    dir = mkdtempSync(join(tmpdir(), "no-eligible-route-"));
  const catalog = {
    ...f.catalog,
    list: () => ({ markets: [] }),
  } as unknown as SwapVMMarketCatalog;
  const aqua = {
    searchStatus: () => ({
      active: 0,
      queued: 0,
      limit: 4,
      perChainLimit: 2,
      selectedTradeChecksQueued: 0,
    }),
  } as unknown as AquaClient;
  class OfflineRunner extends Runner {
    override client() {
      return f.client;
    }
  }
  const runner = new OfflineRunner(
    [f.chain],
    f.settings,
    aqua,
    new Journal(join(dir, "journal.json")),
    new HistoryStore(":memory:"),
    undefined,
    catalog,
  );
  try {
    assert.equal(await runner.scanLatest(42161), false);
    assert.equal(runner.metrics.lastSuccess, 0);
    assert.equal(
      runner.reportingStatus().chains[0]!.activity!.stage,
      "Waiting for an eligible approved market",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
