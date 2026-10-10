import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PublicClient } from "viem";
import { createObservationRuntime } from "../src/observation-runtime.js";
import { loadChains, settingsSchema } from "../src/config.js";
const chain = loadChains().find((c) => c.chainId === 42161)!;
const wallet = `0x${"11".repeat(20)}`;
const operator = `0x${"22".repeat(20)}`;
const dai = "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1";
function settings(enabled = true) {
  return settingsSchema.parse({
    apiUrl: "http://127.0.0.1:1",
    mode: "observe",
    observations: { enabled },
    execution: {
      42161: {
        executor: wallet,
        operator,
        privateKeyEnv: "unused",
        allowBroadcast: false,
        maxGasUnits: "1",
        maxFeePerGas: "1",
        l1FeeReserveWei: "0",
        maxDailyGasWei: "1",
        wrappedNative: chain.pools[0]!.currency0,
        gasConversionFee: 100,
      },
    },
  });
}

test("history runtime is opt-out, fail-soft on storage errors and cannot create trading permissions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observation-runtime-"));
  const disabled = createObservationRuntime({
    settings: settings(false),
    chains: [chain],
    path: join(dir, "disabled.sqlite"),
    client: () => {
      throw new Error("No disabled reads");
    },
  });
  try {
    disabled.start();
    assert.equal(disabled.store, undefined);
    assert.equal(disabled.status().enabled, false);
    assert.equal(existsSync(join(dir, "disabled.sqlite")), false);
    await disabled.stop();
    await disabled.stop();
    writeFileSync(join(dir, "not-a-directory"), "fixture");
    const failed = createObservationRuntime({
      settings: settings(),
      chains: [chain],
      path: join(dir, "not-a-directory/db.sqlite"),
    });
    assert.equal(failed.status().available, false);
    assert.match(failed.status().issue!, /unavailable/);
    await failed.stop();
  } finally {
    await disabled.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history startup samples discovered DAI with units, starts once and leaves execution settings unchanged", async () => {
  const config = settings();
  const before = JSON.stringify(config, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  let starts = 0;
  const runtime = createObservationRuntime({
    settings: config,
    chains: [chain],
    path: ":memory:",
    assets: () => [dai],
    client: () => {
      starts++;
      return {
        getChainId: async () => 42161,
        getBlock: async () => ({
          number: 1n,
          hash: `0x${"ab".repeat(32)}`,
          timestamp: 1790840000n,
        }),
        getBalance: async () => 0n,
        readContract: async ({
          functionName,
          address,
        }: {
          functionName: string;
          address: string;
        }) =>
          functionName === "decimals"
            ? 18
            : functionName === "symbol"
              ? address.toLowerCase() === dai
                ? "DAI"
                : "TOKEN"
              : 1n,
      } as unknown as PublicClient;
    },
  });
  try {
    runtime.start();
    runtime.start();
    for (let i = 0; i < 50 && runtime.status().balanceSampling?.running; i++)
      await sleep(2);
    assert.equal(starts, 1);
    assert.equal(runtime.status().balanceSampling?.lastIssue, null);
    const rows = runtime.store!.balances({
      network: "mainnet",
      asset: dai,
    }).items;
    assert.equal(rows.length, 2);
    assert(rows.every((r) => r.symbol === "DAI" && r.decimals === 18));
    assert.equal(
      JSON.stringify(config, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
      before,
    );
  } finally {
    await runtime.stop();
  }
  assert.equal(runtime.status().available, false);
});

test("shutdown aborts outstanding balance RPC reads before closing the store", async () => {
  let aborted = false;
  const runtime = createObservationRuntime({
    settings: settings(),
    chains: [chain],
    path: ":memory:",
    client: (_, signal) =>
      ({
        getChainId: () =>
          new Promise((_, reject) =>
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("cancelled"));
              },
              { once: true },
            ),
          ),
      }) as unknown as PublicClient,
  });
  runtime.start();
  assert.equal(runtime.status().balanceSampling?.running, true);
  await Promise.all([runtime.stop(), runtime.stop()]);
  assert.equal(aborted, true);
  assert.equal(runtime.status().balanceSampling?.running, false);
  assert.equal(runtime.status().available, false);
});

test("partial balance failure is reported rather than a successful complete sample", async () => {
  const runtime = createObservationRuntime({
    settings: settings(),
    chains: [chain],
    path: ":memory:",
    client: () =>
      ({
        getChainId: async () => {
          throw new Error("private RPC detail");
        },
      }) as unknown as PublicClient,
  });
  try {
    runtime.start();
    for (let i = 0; i < 50 && runtime.status().balanceSampling?.running; i++)
      await sleep(2);
    assert.match(
      runtime.status().balanceSampling?.lastIssue ?? "",
      /unavailable/,
    );
    const rows = runtime.store!.balances({ network: "mainnet" }).items;
    assert(rows.length > 0);
    assert(rows.every((r) => r.amount === null && r.issue !== null));
    assert(!JSON.stringify(rows).includes("private"));
  } finally {
    await runtime.stop();
  }
});
