import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicClient } from "viem";
import { Runner } from "../src/runner.js";
import { AquaClient } from "../src/aqua.js";
import { Journal } from "../src/state.js";
import { RuntimeControls } from "../src/runtime-controls.js";
import { loadChains, settingsSchema } from "../src/config.js";
test("removing every pair or globally pausing cannot stop reconciliation of an existing transaction", async () => {
  const root = mkdtempSync(join(tmpdir(), "rebalancer-lifecycle-")),
    chain = loadChains().find((c) => c.chainId === 8453)!;
  const operator = "0x" + "11".repeat(20),
    executor = "0x" + "22".repeat(20),
    hash = "0x" + "33".repeat(32);
  const config = settingsSchema.parse({
    apiUrl: "http://127.0.0.1:1",
    networkMode: "fork",
    mode: "observe",
    markets: [],
    execution: {
      8453: {
        operator,
        executor,
        privateKeyEnv: "UNUSED_TEST_SIGNER",
        allowBroadcast: false,
        maxGasUnits: "1000",
        maxFeePerGas: "1",
        l1FeeReserveWei: "0",
        maxDailyGasWei: "10000",
        wrappedNative: chain.pools[0]!.currency0,
        gasConversionFee: 500,
      },
    },
  });
  const journal = new Journal(join(root, "journal.json")),
    controls = new RuntimeControls(":memory:", "fork", [8453]);
  let receiptReads = 0,
    quotes = 0;
  const client = {
    getChainId: async () => 8453,
    getCode: async () => "0x6000",
    readContract: async () => chain.poolManager,
    getTransactionReceipt: async () => {
      receiptReads++;
      throw Error("receipt not mined yet");
    },
  } as unknown as PublicClient;
  const aqua = {
    optimize: async () => {
      quotes++;
      throw Error("No markets may be priced");
    },
    searchStatus: () => ({
      active: 0,
      queued: 0,
      limit: 4,
      perChainLimit: 2,
      selectedTradeChecksQueued: 0,
    }),
  } as unknown as AquaClient;
  class ControlledReadRunner extends Runner {
    override client() {
      return client;
    }
  }
  const runner = new ControlledReadRunner(
    [chain],
    config,
    aqua,
    journal,
    undefined,
    undefined,
    undefined,
    controls,
  );
  try {
    journal.set(`8453:${operator}`, {
      day: new Date().toISOString().slice(0, 10),
      reservedWei: "100",
      errors: 0,
      pending: { hash, nonce: 0, id: hash },
    });
    assert.deepEqual(runner.activeChainIds(), [8453]);
    await runner.scanLatest(8453);
    assert.equal(receiptReads, 1);
    assert(journal.get(`8453:${operator}`).pending);
    controls.change(
      { expectedVersion: 0, scope: "all", paused: true },
      "test-admin",
    );
    await runner.scanLatest(8453);
    assert.equal(receiptReads, 2);
    assert(journal.get(`8453:${operator}`).pending);
    assert.equal(quotes, 0);
  } finally {
    controls.close();
    rmSync(root, { recursive: true, force: true });
  }
});
