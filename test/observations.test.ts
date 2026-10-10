import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObservationStore } from "../src/observations.js";
import {
  opportunitySchema,
  balanceObservationSchema,
  type OpportunityRecord,
  type BalanceObservation,
} from "../src/observation-wire.js";
const address = "0x1111111111111111111111111111111111111111",
  other = "0x2222222222222222222222222222222222222222";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const now = "2026-09-29T06:00:00.000Z";
const opportunity = (n = 1): OpportunityRecord =>
  opportunitySchema.parse({
    id: hash(n),
    network: "mainnet",
    chainId: 42161,
    venue: "aqua",
    marketId: hash(100),
    classId: "1",
    caller: address,
    baseToken: address,
    otherToken: other,
    externalPool: other,
    aquaFirst: true,
    amountIn: "5000000",
    quotedGross: "600000",
    conservativeGross: "590000",
    estimatedFee: null,
    estimatedNet: null,
    quoteBlock: "100",
    quoteBlockHash: hash(101),
    foundAt: now,
    updatedAt: now,
    quoteObservedAt: now,
    state: "found",
    reason: null,
    transactionHash: null,
    executionTradeId: null,
  });
const balance = (amount: string | null = "5000000"): BalanceObservation =>
  balanceObservationSchema.parse({
    network: "mainnet",
    chainId: 42161,
    role: "executor",
    wallet: address,
    asset: other,
    symbol: "USDC",
    decimals: 6,
    amount,
    blockNumber: "100",
    blockHash: hash(101),
    blockTimestamp: now,
    observedAt: now,
    source: "periodic",
    issue: amount === null ? "RPC read unavailable" : null,
  });

test("observed candidates survive restart with outcomes and actual fee estimates, never invented net profit", () => {
  const dir = mkdtempSync(join(tmpdir(), "observation-durable-")),
    path = join(dir, "observations.sqlite");
  let store = new ObservationStore(path, () => Date.parse(now));
  try {
    store.found(opportunity());
    store.found(opportunity());
    assert.equal(store.opportunities({ network: "mainnet" }).matchedCount, 1);
    store.update("mainnet", 42161, hash(1), {
      state: "rechecking",
      reason: null,
      estimatedFee: "30000",
      estimatedNet: "560000",
    });
    store.update("mainnet", 42161, hash(1), {
      state: "submitted",
      transactionHash: hash(77),
      executionTradeId: hash(78),
    });
    store.close();
    store = new ObservationStore(path, () => Date.parse(now));
    const row = store.opportunities({ network: "mainnet" }).items[0]!;
    assert.equal(row.state, "submitted");
    assert.equal(row.transactionHash, hash(77));
    assert.equal(row.estimatedNet, "560000");
    assert.throws(
      () =>
        store.update("mainnet", 42161, hash(1), {
          state: "blocked",
          reason: "late callback",
        }),
      /submitted/,
    );
    assert.equal(store.opportunities({ network: "fork" }).matchedCount, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filtered cursors cannot switch network or category and exclude newer inserts without duplicates", () => {
  const store = new ObservationStore(":memory:", () => Date.parse(now));
  try {
    for (let n = 1; n <= 4; n++) store.found(opportunity(n));
    const first = store.opportunities({ network: "mainnet", limit: 2 });
    assert(first.nextCursor);
    store.found(opportunity(5));
    const second = store.opportunities({
      network: "mainnet",
      limit: 2,
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      first.items.map((x) => x.id),
      [hash(4), hash(3)],
    );
    assert.deepEqual(
      second.items.map((x) => x.id),
      [hash(2), hash(1)],
    );
    assert.throws(
      () =>
        store.opportunities({
          network: "fork",
          limit: 2,
          cursor: first.nextCursor!,
        }),
      /cursor/i,
    );
    assert.throws(
      () =>
        store.balances({
          network: "mainnet",
          limit: 2,
          cursor: first.nextCursor!,
        }),
      /cursor/i,
    );
    assert.throws(
      () => store.opportunities({ network: "mainnet", cursor: "not-a-cursor" }),
      /cursor/i,
    );
  } finally {
    store.close();
  }
});

test("unavailable balances are null gaps and retention is explicit, including genuine zero balances", () => {
  const store = new ObservationStore(":memory:", () => Date.parse(now), 3);
  try {
    store.balance(balance("0"));
    store.balance(balance(null));
    const rows = store.balances({ network: "mainnet" }).items;
    assert.equal(rows[0]!.amount, null);
    assert.equal(rows[1]!.amount, "0");
    for (let n = 1; n <= 5; n++) store.found(opportunity(n));
    const page = store.opportunities({ network: "mainnet" });
    assert.equal(page.matchedCount, 3);
    assert.equal(page.coverage.removedRecords, 2);
    assert.equal(page.coverage.retainedLimit, 3);
    assert.throws(
      () => store.balance({ ...balance(), blockHash: null }),
      /Balances require/,
    );
  } finally {
    store.close();
  }
});

test("balance series never mix wallets, native assets or networks and filter actual samples", () => {
  const store = new ObservationStore(":memory:", () => Date.parse(now));
  try {
    store.balance(balance());
    store.balance({
      ...balance("100"),
      role: "operator",
      wallet: other,
      asset: null,
      symbol: "ETH",
      decimals: 18,
    });
    store.balance({ ...balance("999"), network: "fork" });
    const page = store.balances({
      network: "mainnet",
      role: "operator",
      asset: "native",
    });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.amount, "100");
    assert.equal(page.series.length, 1);
    assert.equal(page.series[0]!.role, "operator");
    assert.equal(page.series[0]!.asset, null);
    assert.equal(page.seriesTruncated, false);
  } finally {
    store.close();
  }
});

test("a restart marks unfinished observations interrupted, not submitted or successful", () => {
  const dir = mkdtempSync(join(tmpdir(), "observed-interrupt-")),
    path = join(dir, "observations.sqlite");
  let store = new ObservationStore(path, () => Date.parse(now));
  try {
    store.found(opportunity());
    store.update("mainnet", 42161, hash(1), { state: "rechecking" });
    store.close();
    store = new ObservationStore(path, () => Date.parse(now));
    assert.equal(
      store.opportunities({ network: "mainnet" }).items[0]!.state,
      "interrupted",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("known transaction identity cannot be replaced, erased or demoted by later telemetry", () => {
  const store = new ObservationStore(":memory:");
  try {
    store.found(opportunity());
    store.update("mainnet", 42161, hash(1), {
      state: "submitted",
      transactionHash: hash(77),
      executionTradeId: hash(78),
      executionAmountIn: "4000000",
    });
    const before = store.opportunities({ network: "mainnet" }).items[0];
    for (const change of [
      { transactionHash: hash(79) },
      { transactionHash: null },
      { executionTradeId: hash(80) },
      { executionTradeId: null },
      { executionAmountIn: "1" },
      { executionAmountIn: null },
      { state: "transaction-prepared" as const },
    ])
      assert.throws(
        () => store.update("mainnet", 42161, hash(1), change),
        /submitted/,
      );
    assert.deepEqual(
      store.opportunities({ network: "mainnet" }).items[0],
      before,
    );
    assert.throws(
      () => store.found({ ...opportunity(), classId: "12" }),
      /reused/,
    );
  } finally {
    store.close();
  }
});

test("empty coverage start is persisted and balance summary respects wallet and time filters", () => {
  let clock = Date.parse(now);
  const store = new ObservationStore(":memory:", () => clock);
  try {
    store.begin("mainnet");
    clock += 1000;
    store.begin("mainnet");
    assert.equal(
      store.opportunities({ network: "mainnet" }).coverage.startedAt,
      now,
    );
    store.balance(balance("100"));
    store.balance({
      ...balance("200"),
      observedAt: "2026-09-29T06:01:00.000Z",
    });
    store.balance({ ...balance("300"), wallet: other });
    const page = store.balances({
      network: "mainnet",
      wallet: address,
      to: now,
    });
    assert.equal(page.series.length, 1);
    assert.equal(page.series[0]!.amount, "100");
    assert.equal(page.items.length, 1);
  } finally {
    store.close();
  }
});

test("bounded balance summaries disclose truncation rather than silently dropping series", () => {
  const store = new ObservationStore(":memory:");
  try {
    for (let i = 1; i <= 129; i++)
      store.balance({
        ...balance(),
        wallet: `0x${i.toString(16).padStart(40, "0")}`,
      });
    const page = store.balances({ network: "mainnet" });
    assert.equal(page.series.length, 128);
    assert.equal(page.seriesTruncated, true);
    assert.equal(page.matchedCount, 129);
  } finally {
    store.close();
  }
});
