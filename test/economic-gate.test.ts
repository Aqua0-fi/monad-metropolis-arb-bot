import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicClient } from "viem";
import { submit } from "../src/execution.js";
import { loadChains, settingsSchema } from "../src/config.js";
import { HistoryStore } from "../src/history.js";
import { Journal } from "../src/state.js";
import { Runner } from "../src/runner.js";
import type { AquaClient } from "../src/aqua.js";
import type { Candidate } from "../src/strategy.js";
const chain = loadChains().find((c) => c.chainId === 42161)!;
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const config = settingsSchema.parse({
  mode: "execute",
  networkMode: "fork",
  apiUrl: "http://127.0.0.1:1",
  markets: [],
  execution: {
    42161: {
      executor: a(1),
      operator: a(2),
      privateKeyEnv: "INTENTIONALLY_UNSET_ECONOMIC_TEST_KEY",
      allowBroadcast: true,
      maxGasUnits: "1000000",
      maxFeePerGas: "100",
      maxDailyGasWei: "1000000000",
      l1FeeReserveWei: "0",
      wrappedNative: chain.pools[0]!.currency0,
      gasConversionFee: 500,
    },
  },
});

test("a latched loss blocks before reading a signer or making any submission RPC call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "economic-gate-"));
  const db = new HistoryStore(":memory:");
  const client = new Proxy(
    {},
    {
      get() {
        throw Error("No RPC may run before the loss gate");
      },
    },
  ) as PublicClient;
  try {
    db.latchEconomics("fork", "net_loss");
    await assert.rejects(
      () =>
        submit(
          client,
          chain,
          config,
          {} as Candidate,
          new Journal(join(dir, "journal.json")),
          db,
        ),
      /Economic review required: net_loss/,
    );
    assert.equal(db.list({ network: "fork" }).matchedCount, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live submission cannot silently omit its durable economics history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "economic-history-required-"));
  try {
    await assert.rejects(
      () =>
        submit(
          {} as PublicClient,
          chain,
          config,
          {} as Candidate,
          new Journal(join(dir, "journal.json")),
        ),
      /Durable execution history is required/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("economic pause is visible in live status and does not abandon a pending hash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "economic-reconcile-"));
  const db = new HistoryStore(":memory:");
  const journal = new Journal(join(dir, "journal.json"));
  let receiptReads = 0;
  const client = {
    getChainId: async () => 42161,
    getCode: async () => "0x6000",
    readContract: async () => chain.poolManager,
    getTransactionReceipt: async () => {
      receiptReads++;
      throw Error("not yet mined");
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
  } as AquaClient;
  class TestRunner extends Runner {
    override client() {
      return client;
    }
  }
  const runner = new TestRunner([chain], config, aqua, journal, db);
  try {
    db.latchEconomics("fork", "net_loss");
    const key = `42161:${a(2)}`;
    journal.set(key, {
      day: "2026-09-28",
      reservedWei: "10",
      errors: 0,
      pending: {
        hash: `0x${"ab".repeat(32)}`,
        nonce: 1,
        id: `0x${"cd".repeat(32)}`,
      },
    });
    await runner.scanLatest(42161);
    assert.equal(receiptReads, 1);
    assert(journal.get(key).pending);
    const status = runner.reportingStatus() as unknown as {
      economics: { blocked: boolean; reason: string };
    };
    assert.equal(status.economics.blocked, true);
    assert.equal(status.economics.reason, "net_loss");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
