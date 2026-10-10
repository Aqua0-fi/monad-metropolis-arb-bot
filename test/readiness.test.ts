import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadChains } from "../src/config.js";

test("doctor reports a registered but unconfigured chain without making RPC calls", () => {
  const directory = mkdtempSync(join(tmpdir(), "rebalancer-readiness-"));
  try {
    const file = join(directory, "chains.json");
    writeFileSync(
      file,
      JSON.stringify({
        chains: [
          {
            ...loadChains().find((c) => c.chainId === 8453)!,
            chainId: 999999,
            name: "Unprovisioned fixture",
            publicRpc: undefined,
            rpcEnv: "REBALANCER_ABSENT_TEST_RPC",
            executionReviewed: false,
            pools: [],
            venues: [],
          },
        ],
      }),
    );
    const env = { ...process.env };
    delete env.REBALANCER_ABSENT_TEST_RPC;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "doctor", "--registry", file],
      { encoding: "utf8", env, timeout: 10000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(
      result.status,
      1,
      "an unsupported chain must not pass readiness",
    );
    const rows = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      rows.length,
      1,
      "even a chain with no pools must have a report",
    );
    assert.equal(rows[0].event, "chain_readiness");
    assert.equal(rows[0].chainId, 999999);
    assert.equal(rows[0].status, "blocked");
    assert.equal(rows[0].deploymentVerified, false);
    assert.ok(
      rows[0].blockers.some((s: string) =>
        s.includes("No supported external venue"),
      ),
    );
    assert.ok(
      rows[0].blockers.some((s: string) => s.includes("no configured V4 pool")),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
