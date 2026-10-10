import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadChains, settingsSchema } from "../src/config.js";
import { Journal } from "../src/state.js";
import { runtimeScope, assertPendingScope } from "../src/runtime-scope.js";
const operator = `0x${"11".repeat(20)}`,
  executor = `0x${"22".repeat(20)}`;
const chains = loadChains();
const execution = {
  operator,
  executor,
  privateKeyEnv: "UNUSED_SCOPE_TEST",
  allowBroadcast: false,
  maxGasUnits: "1000",
  maxFeePerGas: "1",
  maxDailyGasWei: "1000",
  l1FeeReserveWei: "0",
  wrappedNative: operator,
  gasConversionFee: 500,
};
const settings = settingsSchema.parse({
  mode: "observe",
  networkMode: "fork",
  apiUrl: "http://127.0.0.1:1",
  markets: [],
  discovery: { enabled: true },
  execution: { 42161: execution, 8453: execution },
});
test("Arbitrum selection narrows runtime work without modifying saved permissions or registry data", () => {
  const before = JSON.stringify(settings, (_, value) =>
    typeof value === "bigint" ? String(value) : value,
  );
  const scope = runtimeScope(chains, settings, "42161");
  assert.deepEqual(
    scope.chains.map((c) => c.chainId),
    [42161],
  );
  assert.deepEqual(Object.keys(scope.settings.execution), ["42161"]);
  assert.equal(
    JSON.stringify(settings, (_, value) =>
      typeof value === "bigint" ? String(value) : value,
    ),
    before,
  );
  assert.equal(chains.length, 8);
  assert.equal(scope.settings.execution[42161]?.allowBroadcast, false);
  assert.throws(
    () => runtimeScope(chains, settings, "garbage"),
    /Unknown chain/,
  );
  assert.throws(() => runtimeScope(chains, settings, "1"), /Unknown chain/);
});
test("narrowing a worker cannot abandon an out-of-scope pending transaction or reset its journal", () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-journal-"));
  const path = join(dir, "journal.json");
  const journal = new Journal(path);
  try {
    journal.reserve(
      `8453:${operator}`,
      `0x${"33".repeat(32)}`,
      1,
      "trade",
      1n,
      100n,
      true,
    );
    const before = readFileSync(path, "utf8");
    const scope = runtimeScope(chains, settings, "42161");
    assert.throws(
      () => assertPendingScope(journal, scope.chains, scope.settings),
      /Pending transaction.*8453/,
    );
    assert.equal(readFileSync(path, "utf8"), before);
    assertPendingScope(journal, chains, settings);
    const changed = {
      ...settings,
      execution: {
        ...settings.execution,
        8453: {
          ...settings.execution[8453]!,
          operator: settings.execution[8453]!.executor,
        },
      },
    };
    assert.throws(
      () => assertPendingScope(journal, chains, changed),
      /operator configuration/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit receipt review can read a previously used chain without activating it", async () => {
  const { receiptReviewClients } = await import("../src/runtime-scope.js");
  const made: number[] = [];
  const resolve = receiptReviewClients(chains, (chain) => {
    made.push(chain.chainId);
    return { chainId: chain.chainId } as unknown as import("viem").PublicClient;
  });
  const scope = runtimeScope(chains, settings, "42161");
  assert.deepEqual(made, []);
  const first = resolve(8453);
  assert.equal(resolve(8453), first);
  assert.deepEqual(made, [8453]);
  assert.deepEqual(
    scope.chains.map((chain) => chain.chainId),
    [42161],
  );
  assert.deepEqual(Object.keys(scope.settings.execution), ["42161"]);
  assert.throws(() => resolve(999999), /Unknown receipt-review chain/);
});
