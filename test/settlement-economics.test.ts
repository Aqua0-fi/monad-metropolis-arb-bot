import test from "node:test";
import assert from "node:assert/strict";
import type { PublicClient, TransactionReceipt } from "viem";
import {
  checkedL1Fee,
  valueSettlementFees,
} from "../src/settlement-economics.js";
import { HistoryStore, type ExecutionRecord } from "../src/history.js";
import { verifyEconomicAnchors } from "../src/economic-gate.js";
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
function fixture() {
  const record: ExecutionRecord = {
    version: 1,
    network: "fork",
    chainId: 42161,
    transactionHash: h(1),
    tradeId: h(2),
    executor: a(1),
    operator: a(2),
    poolId: h(3),
    aqua0Hook: a(3),
    tokenIn: a(4),
    tokenOut: a(5),
    amountIn: "1000000",
    minimumProfit: "1",
    quotedNetProfit: "10",
    aquaFirst: true,
    preparedAt: "2026-09-28T00:00:00.000Z",
    status: "pending",
    broadcastAcknowledged: true,
    receipt: null,
    feePolicy: {
      feeModel: "gas-limit",
      nativeCurrency: { symbol: "ETH", decimals: 18 },
      nativeEquivalent: null,
      wrappedNative: a(4),
      gasConversionFee: 500,
      venues: [],
    },
  };
  const receipt = {
    transactionHash: h(1),
    blockHash: h(10),
    blockNumber: 10n,
    from: a(2),
    to: a(1),
    gasUsed: 100n,
    effectiveGasPrice: 2n,
    status: "success",
    logs: [],
  } as unknown as TransactionReceipt;
  const decoded: NonNullable<ExecutionRecord["receipt"]> = {
    blockNumber: "10",
    blockHash: h(10),
    blockTimestamp: "2026-09-28T00:00:00.000Z",
    checkedAt: "2026-09-28T00:00:01.000Z",
    logIndex: 0,
    grossProfit: "1000",
    executionGasNative: "200",
    additionalGasNative: "0",
    totalGasNative: "200",
    settlements: [],
  };
  const calls: { functionName: string; blockNumber: bigint }[] = [];
  const client = {
    getChainId: async () => 42161,
    getBlock: async () => ({ hash: h(10) }),
    readContract: async (x: { functionName: string; blockNumber: bigint }) => {
      calls.push(x);
      return x.functionName === "symbol" ? "WETH" : 18;
    },
  } as unknown as PublicClient;
  return { record, receipt, decoded, calls, client };
}
test("receipt gas is valued in the equivalent starting token at its canonical block", async () => {
  const f = fixture();
  const result = await valueSettlementFees(
    f.client,
    f.record,
    f.receipt,
    f.decoded,
  );
  assert.equal(result.feeValuation?.tokenCost, "200");
  assert.equal(result.feeValuation?.method, "native-equivalent");
  assert.equal(result.feeValuation?.blockHash, h(10));
  assert.equal(result.feeIssue, null);
  assert(f.calls.every((x) => x.blockNumber === 10n));
});
test("a reverted trade keeps its real fee expense and creates a realized-loss pause", async () => {
  const f = fixture();
  f.receipt.status = "reverted";
  f.decoded.grossProfit = null;
  f.decoded.logIndex = null;
  const result = await valueSettlementFees(
    f.client,
    f.record,
    f.receipt,
    f.decoded,
  );
  const db = new HistoryStore(":memory:");
  try {
    db.prepare(f.record);
    db.settle("fork", 42161, h(1), "reverted", result);
    const s = db.economics("fork");
    assert.equal(s.totals[0]?.netResult, "-200");
    assert.equal(s.totals[0]?.grossProfit, "0");
    assert.equal(s.blocked, true);
  } finally {
    db.close();
  }
});
test("failed historical metadata does not erase actual native fees or invent a conversion", async () => {
  const f = fixture();
  const client = {
    ...f.client,
    readContract: async () => {
      throw Error("rate limited");
    },
  } as unknown as PublicClient;
  const r = await valueSettlementFees(client, f.record, f.receipt, f.decoded);
  assert.equal(r.feeValuation, null);
  assert.equal(r.totalGasNative, "200");
  assert.match(r.feeIssue!, /unavailable/);
});
test("OP extra fees require raw fields tied to exactly the same receipt", async () => {
  const f = fixture();
  f.record.feePolicy!.feeModel = "op-stack";
  const raw = {
    transactionHash: h(1),
    blockHash: h(10),
    blockNumber: "0xa",
    from: a(2),
    to: a(1),
    gasUsed: "0x64",
    effectiveGasPrice: "0x2",
    status: "0x1",
    l1Fee: "0x14",
    operatorFee: "0x5",
  };
  assert.equal(checkedL1Fee(raw, f.receipt), 20n);
  assert.throws(
    () => checkedL1Fee({ ...raw, transactionHash: h(2) }, f.receipt),
    /identity/,
  );
  const client = {
    ...f.client,
    request: async () => raw,
    readContract: async (x: { functionName: string }) =>
      x.functionName === "getOperatorFee"
        ? 5n
        : x.functionName === "symbol"
          ? "WETH"
          : 18,
  } as unknown as PublicClient;
  const r = await valueSettlementFees(client, f.record, f.receipt, f.decoded);
  assert.equal(r.totalGasNative, "225");
  assert.equal(r.feeValuation?.tokenCost, "225");
  const missing = {
    ...client,
    request: async () => ({ ...raw, l1Fee: undefined }),
  } as unknown as PublicClient;
  const unavailable = await valueSettlementFees(
    missing,
    f.record,
    f.receipt,
    f.decoded,
  );
  assert.equal(unavailable.totalGasNative, null);
  assert.equal(unavailable.feeValuation, null);
});
test("receipt reorganization invalidates fee valuation and latches the next execution check", async () => {
  const f = fixture();
  const old = await valueSettlementFees(
    f.client,
    f.record,
    f.receipt,
    f.decoded,
  );
  const db = new HistoryStore(":memory:");
  const changed = {
    ...f.client,
    getBlock: async () => ({ hash: h(11) }),
  } as unknown as PublicClient;
  try {
    db.prepare(f.record);
    db.settle("fork", 42161, h(1), "confirmed", old);
    assert.equal(db.economics("fork").blocked, false);
    await assert.rejects(
      () => verifyEconomicAnchors(db, "fork", 42161, changed),
      /canonicality changed/,
    );
    assert.equal(db.economics("fork").reason, "canonicality_changed");
    assert.equal(
      (await valueSettlementFees(changed, f.record, f.receipt, f.decoded))
        .feeValuation,
      null,
    );
  } finally {
    db.close();
  }
});

test("receipt-anchor reuse checks canonical ancestry without rereading all old blocks on every trade", async () => {
  const f = fixture();
  const db = new HistoryStore(":memory:");
  const valued = await valueSettlementFees(
    f.client,
    f.record,
    f.receipt,
    f.decoded,
  );
  const reads: bigint[] = [];
  const client = {
    getChainId: async () => 42161,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      reads.push(blockNumber);
      return { hash: h(Number(blockNumber)) };
    },
  } as unknown as PublicClient;
  try {
    for (const number of [10, 11]) {
      const record = { ...f.record, transactionHash: h(number) };
      db.prepare(record);
      db.settle("fork", 42161, record.transactionHash, "confirmed", {
        ...valued,
        blockNumber: String(number),
        blockHash: h(number),
        feeValuation: {
          ...valued.feeValuation!,
          blockNumber: String(number),
          blockHash: h(number),
        },
      });
    }
    await verifyEconomicAnchors(db, "fork", 42161, client);
    assert.deepEqual(reads, [10n, 11n]);
    reads.length = 0;
    await verifyEconomicAnchors(db, "fork", 42161, client);
    assert.deepEqual(
      reads,
      [11n],
      "the unchanged highest verified block commits to the same previously checked ancestry",
    );
    const otherClient = { ...client } as PublicClient;
    reads.length = 0;
    await verifyEconomicAnchors(db, "fork", 42161, otherClient);
    assert.deepEqual(
      reads,
      [10n, 11n],
      "a different client must not inherit cached proof",
    );
  } finally {
    db.close();
  }
});
