import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, acquireLock } from "../src/state.js";
const hash = `0x${"01".repeat(32)}` as const;
test("durable journal prevents duplicate sends and persists restart state", () => {
  const dir = mkdtempSync(join(tmpdir(), "rebalancer-"));
  try {
    const path = join(dir, "state.json");
    const j = new Journal(path);
    j.reserve("8453", hash, 7, "trade", 20n, 100n);
    const loaded = new Journal(path);
    assert.equal(loaded.get("8453").pending?.nonce, 7);
    assert.throws(() => loaded.reserve("8453", hash, 8, "trade2", 20n, 100n));
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("gas reservation fails before exceeding daily budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "rebalancer-"));
  try {
    const j = new Journal(join(dir, "state.json"));
    assert.throws(() => j.reserve("x", hash, 1, "t", 101n, 100n));
    assert.equal(j.get("x").pending, undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("corrupt journal is never replaced by empty state", () => {
  const dir = mkdtempSync(join(tmpdir(), "rebalancer-"));
  try {
    const p = join(dir, "state.json");
    writeFileSync(p, "invalid");
    assert.throws(() => new Journal(p));
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("single-process lock rejects a second worker", () => {
  const dir = mkdtempSync(join(tmpdir(), "rebalancer-"));
  try {
    const path = join(dir, "lock");
    const release = acquireLock(path);
    assert.throws(() => acquireLock(path));
    release();
    acquireLock(path)();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
