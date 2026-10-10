import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore, type ExecutionRecord } from "../src/history.js";
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
function pending(
  n: number,
  network: "fork" | "mainnet" = "fork",
): ExecutionRecord {
  return {
    version: 1,
    network,
    chainId: 8453,
    transactionHash: hash(n),
    tradeId: hash(n + 100),
    executor: address(1),
    operator: address(2),
    poolId: hash(90),
    aqua0Hook: address(3),
    tokenIn: address(4),
    tokenOut: address(5),
    amountIn: "1000000",
    minimumProfit: "1",
    quotedNetProfit: "50",
    aquaFirst: true,
    preparedAt: "2026-09-28T00:00:00.000Z",
    status: "pending",
    broadcastAcknowledged: false,
    receipt: null,
  };
}
function receipt(
  n: number,
  gross: string,
  cost: string | null,
  token = address(4),
) {
  const r = {
    blockNumber: String(n),
    blockHash: hash(n + 1000),
    blockTimestamp: "2026-09-28T00:00:00.000Z",
    checkedAt: "2026-09-28T00:00:01.000Z",
    logIndex: 1,
    grossProfit: gross,
    executionGasNative: "12",
    additionalGasNative: "3",
    totalGasNative: "15",
    settlements: [],
  };
  return {
    ...r,
    feeValuation:
      cost === null
        ? null
        : {
            version: 1 as const,
            token,
            tokenCost: cost,
            nativeCost: "15",
            blockNumber: r.blockNumber,
            blockHash: r.blockHash,
            tokenDecimals: 6,
            tokenSymbol: "TEST",
            nativeDecimals: 18,
            nativeSymbol: "ETH",
            method: "v3-exact-output" as const,
            conversionToken: address(6),
            conversionAmount: "15",
            quoter: address(7),
            pool: address(8),
            fee: 500,
          },
  };
}
function settle(
  db: HistoryStore,
  n: number,
  gross: string,
  cost: string | null,
  status: "confirmed" | "reverted" = "confirmed",
  token = address(4),
) {
  const p = { ...pending(n), tokenIn: token };
  if (!db.get("fork", 8453, p.transactionHash)) db.prepare(p);
  db.settle("fork", 8453, p.transactionHash, status, {
    ...receipt(n, gross, cost, token),
    grossProfit: status === "reverted" ? null : gross,
    logIndex: status === "reverted" ? null : 1,
  });
}
test("economic results include successful gross gains, successful and reverted gas, and never mix tokens", () => {
  const db = new HistoryStore(":memory:");
  try {
    settle(db, 2, "20", "40");
    settle(db, 1, "100", "30");
    settle(db, 3, "0", "50", "reverted");
    settle(db, 4, "900", "1", "confirmed", address(99));
    const s = db.economics("fork");
    const a = s.totals.find((x) => x.token === address(4))!;
    const b = s.totals.find((x) => x.token === address(99))!;
    assert.equal(a.grossProfit, "120");
    assert.equal(a.feesInToken, "120");
    assert.equal(a.netResult, "0");
    assert.equal(a.profitable, 1);
    assert.equal(a.lossMaking, 2);
    assert.equal(a.reverted, 1);
    assert.equal(b.netResult, "899");
    assert.equal(
      s.blocked,
      true,
      "negative result during the window must latch even if later values reach break-even",
    );
    assert.equal(db.economics("mainnet").totals.length, 0);
  } finally {
    db.close();
  }
});
test("net-loss pause persists across restart and requires a versioned explicit review without erasing lifetime losses", () => {
  const dir = mkdtempSync(join(tmpdir(), "rebalancer-economics-"));
  const path = join(dir, "history.sqlite");
  let db = new HistoryStore(path);
  try {
    settle(db, 1, "20", "35");
    let s = db.economics("fork");
    assert.equal(s.reason, "net_loss");
    db.close();
    db = new HistoryStore(path);
    s = db.economics("fork");
    assert(s.blocked);
    assert.throws(
      () =>
        db.reviewEconomics(
          "fork",
          {
            expectedVersion: s.version - 1,
            throughSettlement: s.throughSettlement,
            reason: "Inspected fees",
            acknowledgeLosses: true,
          },
          "ops",
        ),
      /conflict/i,
    );
    db.reviewEconomics(
      "fork",
      {
        expectedVersion: s.version,
        throughSettlement: s.throughSettlement,
        reason: "Inspected the fee loss",
        acknowledgeLosses: true,
      },
      "ops",
    );
    const reviewed = db.economics("fork");
    assert.equal(reviewed.blocked, false);
    assert.equal(reviewed.totals[0]?.netResult, "-15");
    assert.equal(reviewed.window.length, 0);
    assert.equal(reviewed.audit.length, 1);
    settle(db, 2, "5", "10");
    assert.equal(db.economics("fork").blocked, true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("unknown costs block review, enrichment is counted once, and old pending transactions enter the next review window when settled", () => {
  const db = new HistoryStore(":memory:");
  try {
    db.prepare(pending(1));
    settle(db, 2, "50", null);
    let s = db.economics("fork");
    assert.equal(s.reason, "cost_unavailable");
    assert.equal(s.totals[0]?.netResult, null);
    assert.throws(
      () =>
        db.reviewEconomics(
          "fork",
          {
            expectedVersion: s.version,
            throughSettlement: s.throughSettlement,
            reason: "Reviewed unknown",
            acknowledgeLosses: true,
          },
          "ops",
        ),
      /pending|unavailable/i,
    );
    settle(db, 2, "50", "10");
    settle(db, 1, "20", "1");
    s = db.economics("fork");
    db.reviewEconomics(
      "fork",
      {
        expectedVersion: s.version,
        throughSettlement: s.throughSettlement,
        reason: "All receipts checked",
        acknowledgeLosses: true,
      },
      "ops",
    );
    db.prepare(pending(3));
    const prior = db.economics("fork");
    assert.equal(prior.pending, 1);
    settle(db, 3, "2", "10");
    const after = db.economics("fork");
    assert.equal(after.window[0]?.netResult, "-8");
    const version = after.version;
    settle(db, 3, "2", "10");
    assert.equal(db.economics("fork").version, version);
    assert.equal(db.economics("fork").totals[0]?.confirmed, 3);
  } finally {
    db.close();
  }
});
test("receipt and valuation identity cannot disagree or hide a missing native fee", () => {
  const db = new HistoryStore(":memory:");
  try {
    db.prepare(pending(1));
    db.settle("fork", 8453, hash(1), "confirmed", {
      ...receipt(1, "100", "1"),
      totalGasNative: null,
    });
    const s = db.economics("fork");
    assert.equal(s.blocked, true);
    assert.equal(s.totals[0]?.unknownCost, 1);
    assert.equal(s.totals[0]?.netResult, null);
    db.prepare(pending(2));
    db.settle(
      "fork",
      8453,
      hash(2),
      "confirmed",
      receipt(2, "100", "1", address(99)),
    );
    assert.equal(db.economics("fork").totals[0]?.unknownCost, 2);
  } finally {
    db.close();
  }
});
