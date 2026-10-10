import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HistoryStore, type ExecutionRecord } from "../src/history.js";

const token = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
export const record = (n: number, chainId = 8453): ExecutionRecord => ({
  version: 1,
  network: "fork",
  chainId,
  transactionHash: hash(n),
  tradeId: hash(n + 100),
  executor: token(1),
  operator: token(2),
  poolId: hash(55),
  aqua0Hook: token(3),
  tokenIn: token(4),
  tokenOut: token(5),
  amountIn: "1000000",
  minimumProfit: "20",
  quotedNetProfit: "25",
  aquaFirst: true,
  preparedAt: "2026-09-24T00:00:00.000Z",
  status: "pending",
  broadcastAcknowledged: false,
  receipt: null,
});
test("history survives restart, keeps transaction identity immutable and never downgrades a receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "rebalancer-history-"));
  let db = new HistoryStore(join(dir, "history.sqlite"));
  try {
    db.prepare(record(1));
    db.close();
    db = new HistoryStore(join(dir, "history.sqlite"));
    assert.equal(db.get("fork", 8453, hash(1))?.tradeId, hash(101));
    assert.throws(
      () => db.prepare({ ...record(1), amountIn: "2" }),
      /identity/,
    );
    db.acknowledgeBroadcast("fork", 8453, hash(1));
    db.prepare(record(1));
    assert.equal(db.get("fork", 8453, hash(1))?.broadcastAcknowledged, true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});
test("keyset pagination is stable across new writes and isolated by network, chain and pair", () => {
  const db = new HistoryStore(":memory:");
  try {
    db.prepare(record(1));
    db.prepare(record(2));
    db.prepare(record(3, 42161));
    db.prepare({ ...record(4), network: "mainnet" });
    const first = db.list({ network: "fork", chainId: 8453, limit: 1 });
    assert.equal(first.items[0]?.transactionHash, hash(2));
    assert(first.nextCursor);
    db.prepare(record(5));
    const second = db.list({
      network: "fork",
      chainId: 8453,
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(second.items[0]?.transactionHash, hash(1));
    assert.equal(second.nextCursor, null);
    assert.equal(db.list({ network: "mainnet", limit: 10 }).items.length, 1);
    assert.equal(
      db.list({ network: "fork", token: token(99), limit: 10 }).items.length,
      0,
    );
    assert.throws(
      () => db.list({ network: "fork", limit: 1, cursor: first.nextCursor! }),
      /cursor/,
    );
  } finally {
    db.close();
  }
});
test("invalid identities and zero limits cannot create files or unbounded reads", () => {
  const db = new HistoryStore(":memory:");
  try {
    assert.throws(() =>
      db.prepare({ ...record(1), transactionHash: "../../bad" }),
    );
    assert.throws(() => db.list({ network: "fork", limit: 0 }));
    assert.throws(() => db.list({ network: "fork", limit: 101 }));
  } finally {
    db.close();
  }
});

test("equivalent UTC timestamps include the same boundary record", () => {
  const db = new HistoryStore(":memory:");
  try {
    db.prepare(record(1));
    assert.equal(
      db.list({ network: "fork", from: "2026-09-24T00:00:00Z", limit: 10 })
        .matchedCount,
      1,
    );
    assert.equal(
      db.list({ network: "fork", from: "2026-09-24T00:00:00.000Z", limit: 10 })
        .matchedCount,
      1,
    );
  } finally {
    db.close();
  }
});
