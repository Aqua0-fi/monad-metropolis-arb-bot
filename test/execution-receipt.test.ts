import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodeEventLog,
  encodeAbiParameters,
  parseAbiParameters,
  type TransactionReceipt,
} from "viem";
import { executionSchema } from "../src/history.js";
import { executionReceipt } from "../src/execution-history.js";
import { loadChains } from "../src/config.js";
import { executorAbi } from "../src/abi.js";

function fixture() {
  const saved = JSON.parse(
    readFileSync("test/fixtures/arbitrum-first-execution.json", "utf8"),
  );
  const raw = saved.receipt;
  const receipt = {
    ...raw,
    blockNumber: BigInt(raw.blockNumber),
    gasUsed: BigInt(raw.gasUsed),
    cumulativeGasUsed: BigInt(raw.cumulativeGasUsed),
    effectiveGasPrice: BigInt(raw.effectiveGasPrice),
    logs: raw.logs.map((log: Record<string, unknown>) => ({
      ...log,
      blockNumber: BigInt(log.blockNumber as string),
    })),
  } as TransactionReceipt;
  const record = executionSchema.parse(saved.record);
  const chain = loadChains().find((c) => c.chainId === 42161)!;
  const timestamp = BigInt(saved.blockTimestamp);
  return { record, receipt, chain, timestamp };
}
function matchingLogs(f: ReturnType<typeof fixture>) {
  return f.receipt.logs.filter(
    (log) => log.address.toLowerCase() === f.record.executor.toLowerCase(),
  );
}

test("the real successful SwapVM leg and final Executed event are distinct receipt facts", () => {
  const f = fixture();
  const events = matchingLogs(f).map((log) =>
    decodeEventLog({ abi: executorAbi, data: log.data, topics: log.topics }),
  );
  assert.deepEqual(
    events.map((e) => e.eventName),
    ["SwapVMLegExecuted", "Executed"],
  );
  const decoded = executionReceipt(f.record, f.receipt, f.timestamp, f.chain);
  assert.equal(decoded.grossProfit, "704396");
  assert.equal(decoded.swapVM?.amountIn, "3871550");
  assert.equal(decoded.swapVM?.amountOut, "1717733607247477");
  assert.equal(decoded.swapVM?.strategyId, f.record.swapVM!.stableStrategyId);
  assert.equal(decoded.executionGasNative, "17603901000000");
  assert.equal(decoded.totalGasNative, "17603901000000");
  assert.equal(decoded.logIndex, 27);
  assert.equal(decoded.swapVM?.logIndex, 23);
});

test("event order cannot turn the final profit event into another SwapVM leg", () => {
  const f = fixture();
  f.receipt.logs.reverse();
  assert.equal(
    executionReceipt(f.record, f.receipt, f.timestamp, f.chain).grossProfit,
    "704396",
  );
});

test("duplicate matching leg or execution evidence remains a refusal", () => {
  for (const index of [0, 1]) {
    const f = fixture();
    f.receipt.logs.push({ ...matchingLogs(f)[index]!, logIndex: 99 });
    assert.throws(
      () => executionReceipt(f.record, f.receipt, f.timestamp, f.chain),
      /Duplicate execution|SwapVM receipt identity/,
    );
  }
});

test("a mismatched actual SwapVM class, router, strategy or amount never acquires settlement credit", () => {
  for (const change of [
    { classId: "2" },
    { router: "0x1111111111111111111111111111111111111111" },
    { stableStrategyId: `0x${"cc".repeat(32)}` },
  ]) {
    const f = fixture();
    f.record.swapVM = { ...f.record.swapVM!, ...change };
    assert.throws(
      () => executionReceipt(f.record, f.receipt, f.timestamp, f.chain),
      /SwapVM receipt identity/,
    );
  }
  const f = fixture();
  const leg = matchingLogs(f)[0]!;
  leg.data = encodeAbiParameters(
    parseAbiParameters("bytes32,uint256,address,address,uint256,uint256"),
    [
      f.record.swapVM!.orderHash as `0x${string}`,
      1n,
      f.record.tokenIn as `0x${string}`,
      f.record.tokenOut as `0x${string}`,
      0n,
      1n,
    ],
  );
  assert.throws(
    () => executionReceipt(f.record, f.receipt, f.timestamp, f.chain),
    /SwapVM receipt identity/,
  );
});

test("missing venue or final execution events, and a successful log claimed as reverted, remain invalid", () => {
  for (const index of [0, 1]) {
    const f = fixture();
    const removed = matchingLogs(f)[index]!;
    f.receipt.logs = f.receipt.logs.filter((log) => log !== removed);
    assert.throws(
      () => executionReceipt(f.record, f.receipt, f.timestamp, f.chain),
      /no matching/,
    );
  }
  const f = fixture();
  f.receipt.status = "reverted";
  assert.throws(
    () => executionReceipt(f.record, f.receipt, f.timestamp, f.chain),
    /Reverted receipt/,
  );
});
