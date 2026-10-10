import test from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { HistoryStore, type ExecutionRecord } from "../src/history.js";
import { reviewEconomicWindow } from "../src/economic-review.js";
const address = `0x${"11".repeat(20)}`,
  hash = `0x${"22".repeat(32)}`;
function setup() {
  const db = new HistoryStore(":memory:");
  const record: ExecutionRecord = {
    version: 1,
    network: "fork",
    chainId: 42161,
    transactionHash: hash,
    tradeId: hash,
    executor: address,
    operator: address,
    poolId: hash,
    aqua0Hook: address,
    tokenIn: address,
    tokenOut: `0x${"33".repeat(20)}`,
    amountIn: "100",
    minimumProfit: "1",
    quotedNetProfit: "2",
    aquaFirst: true,
    preparedAt: "2026-09-28T00:00:00.000Z",
    status: "pending",
    broadcastAcknowledged: true,
    receipt: null,
  };
  db.prepare(record);
  db.settle("fork", 42161, hash, "confirmed", {
    blockNumber: "10",
    blockHash: hash,
    blockTimestamp: "2026-09-28T00:00:00.000Z",
    checkedAt: "2026-09-28T00:00:01.000Z",
    logIndex: 1,
    grossProfit: "2",
    executionGasNative: "5",
    additionalGasNative: "0",
    totalGasNative: "5",
    settlements: [],
    feeValuation: {
      version: 1,
      token: address,
      tokenCost: "5",
      nativeCost: "5",
      blockNumber: "10",
      blockHash: hash,
      tokenDecimals: 18,
      tokenSymbol: "TEST",
      nativeDecimals: 18,
      nativeSymbol: "ETH",
      method: "native-equivalent",
      conversionToken: address,
      conversionAmount: "5",
      quoter: null,
      pool: null,
      fee: null,
    },
  });
  const state = db.economics("fork");
  const input = {
    expectedVersion: state.version,
    throughSettlement: state.throughSettlement,
    acknowledgeLosses: true,
    reason: "Reviewed the real transaction fee loss",
  };
  return { db, record, input };
}
const client = {
  getChainId: async () => 42161,
  getBlock: async () => ({ hash }),
} as unknown as PublicClient;
test("explicit review checks canonical receipts, retains lifetime loss, and writes an audit window", async () => {
  const { db, input } = setup();
  try {
    const result = await reviewEconomicWindow(
      db,
      "fork",
      input,
      "admin",
      () => client,
    );
    assert.equal(result.blocked, false);
    assert.equal(result.totals[0]?.netResult, "-3");
    assert.equal(result.window.length, 0);
    assert.equal(result.audit.length, 1);
  } finally {
    db.close();
  }
});
test("a reorg or unavailable RPC cannot be acknowledged away", async () => {
  for (const getBlock of [
    async () => ({ hash: `0x${"44".repeat(32)}` }),
    async () => {
      throw Error("offline");
    },
  ]) {
    const { db, input } = setup();
    try {
      await assert.rejects(() =>
        reviewEconomicWindow(
          db,
          "fork",
          input,
          "admin",
          () => ({ ...client, getBlock }) as PublicClient,
        ),
      );
      assert.equal(db.economics("fork").blocked, true);
      assert.equal(db.economics("fork").audit.length, 0);
    } finally {
      db.close();
    }
  }
});
test("stale review identity, pending transactions and hidden execution fields are refused", async () => {
  const { db, input, record } = setup();
  try {
    await assert.rejects(
      () =>
        reviewEconomicWindow(
          db,
          "fork",
          { ...input, expectedVersion: 0 },
          "admin",
          () => client,
        ),
      /conflict/i,
    );
    await assert.rejects(() =>
      reviewEconomicWindow(
        db,
        "fork",
        { ...input, allowBroadcast: true },
        "admin",
        () => client,
      ),
    );
    db.prepare({ ...record, transactionHash: `0x${"55".repeat(32)}` });
    const now = db.economics("fork");
    await assert.rejects(
      () =>
        reviewEconomicWindow(
          db,
          "fork",
          { ...input, expectedVersion: now.version },
          "admin",
          () => client,
        ),
      /pending/i,
    );
    assert.equal(db.economics("fork").blocked, true);
  } finally {
    db.close();
  }
});
test("a settlement arriving during review makes the approval stale", async () => {
  const { db, input, record } = setup();
  let changed = false;
  const racing = {
    ...client,
    getBlock: async () => {
      if (!changed) {
        changed = true;
        db.prepare({ ...record, transactionHash: `0x${"66".repeat(32)}` });
      }
      return { hash };
    },
  } as PublicClient;
  try {
    await assert.rejects(
      () => reviewEconomicWindow(db, "fork", input, "admin", () => racing),
      /changed|conflict|pending/i,
    );
    assert.equal(db.economics("fork").blocked, true);
    assert.equal(db.economics("fork").audit.length, 0);
  } finally {
    db.close();
  }
});

test("freshly recovered fee evidence requires a second, informed versioned review", async () => {
  const setupState = setup();
  setupState.db.close();
  const db = new HistoryStore(":memory:");
  const record = {
    ...setupState.record,
    feePolicy: {
      feeModel: "gas-limit" as const,
      nativeCurrency: { symbol: "ETH", decimals: 18 },
      nativeEquivalent: null,
      wrappedNative: address,
      gasConversionFee: 500,
      venues: [],
    },
  };
  db.prepare(record);
  db.settle("fork", 42161, hash, "confirmed", {
    blockNumber: "10",
    blockHash: hash,
    blockTimestamp: "2026-09-28T00:00:00.000Z",
    checkedAt: "2026-09-28T00:00:01.000Z",
    logIndex: 1,
    grossProfit: "2",
    executionGasNative: "5",
    additionalGasNative: "0",
    totalGasNative: "5",
    settlements: [],
    feeValuation: null,
  });
  const recovery = {
    ...client,
    getTransactionReceipt: async () => ({
      transactionHash: hash,
      blockHash: hash,
      blockNumber: 10n,
      from: address,
      to: address,
      status: "success",
      gasUsed: 5n,
      effectiveGasPrice: 1n,
    }),
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "symbol" ? "TEST" : 18,
  } as unknown as PublicClient;
  const change = () => ({
    expectedVersion: db.economics("fork").version,
    throughSettlement: db.economics("fork").throughSettlement,
    reason: "Inspected the recovered fee amount",
    acknowledgeLosses: true,
  });
  try {
    await assert.rejects(
      () => reviewEconomicWindow(db, "fork", change(), "admin", () => recovery),
      /evidence updated/,
    );
    assert.equal(db.economics("fork").totals[0]?.unknownCost, 0);
    assert.equal(db.economics("fork").blocked, true);
    assert.equal(db.economics("fork").audit.length, 0);
    const reviewed = await reviewEconomicWindow(
      db,
      "fork",
      change(),
      "admin",
      () => recovery,
    );
    assert.equal(reviewed.blocked, false);
    assert.equal(reviewed.totals[0]?.netResult, "-3");
  } finally {
    db.close();
  }
});

test("a slow evidence read cannot clear the pause after the review deadline", async () => {
  const { db, input } = setup();
  let clock = 0;
  const slow = {
    ...client,
    getBlock: async () => {
      clock = 6000;
      return { hash };
    },
  } as PublicClient;
  try {
    await assert.rejects(
      () =>
        reviewEconomicWindow(
          db,
          "fork",
          input,
          "admin",
          () => slow,
          () => clock,
        ),
      /timed out/,
    );
    assert.equal(db.economics("fork").blocked, true);
    assert.equal(db.economics("fork").audit.length, 0);
  } finally {
    db.close();
  }
});
