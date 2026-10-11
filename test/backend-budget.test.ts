import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackendBudget,
  BackendBudgetExceeded,
  DEFAULT_BUDGET_LIMITS,
} from "../src/backend-budget.js";
import { AquaClient } from "../src/aqua.js";

const limits = {
  catalog: { perMinute: 0, perHour: 0, perDay: 0 },
  search: { perMinute: 2, perHour: 3, perDay: 4 },
  authorize: { perMinute: 1, perHour: 1, perDay: 1 },
};

test("each window caps its class and refusals are typed", () => {
  let now = 1_000_000;
  const budget = new BackendBudget(limits, undefined, () => now);
  budget.take("search");
  budget.take("search");
  assert.throws(
    () => budget.take("search"),
    (e: unknown) => e instanceof BackendBudgetExceeded && e.window === "minute",
  );
  now += 61_000;
  budget.take("search");
  assert.throws(
    () => budget.take("search"),
    (e: unknown) => e instanceof BackendBudgetExceeded && e.window === "hour",
  );
  now += 3_601_000;
  budget.take("search");
  assert.throws(
    () => budget.take("search"),
    (e: unknown) => e instanceof BackendBudgetExceeded && e.window === "day",
  );
  assert.throws(() => budget.take("catalog"), BackendBudgetExceeded);
  assert.equal(budget.status().search.refusedThisProcess, 3);
  now += 86_400_000;
  assert.doesNotThrow(() => budget.take("search"));
});

test("spent budget survives a restart and a corrupt ledger fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-"));
  const file = join(dir, "nested", "budget.json");
  const now = () => 5_000_000;
  const first = new BackendBudget(limits, file, now);
  first.take("authorize");
  const second = new BackendBudget(limits, file, now);
  assert.throws(() => second.take("authorize"), BackendBudgetExceeded);
  assert.equal(second.status().authorize.lastDay, 1);
  writeFileSync(file, "{not json");
  assert.throws(() => new BackendBudget(limits, file, now));
  writeFileSync(
    file,
    JSON.stringify({ version: 1, calls: { search: ["x"], catalog: [] } }),
  );
  assert.throws(() => new BackendBudget(limits, file, now));
  assert.match(readFileSync(file, "utf8"), /version/);
});

test("the backend client refuses before any network request once a budget is spent", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    throw new Error("network must not be reached");
  }) as typeof fetch;
  try {
    const client = new AquaClient(
      "https://staging-api.aqua0.xyz",
      {},
      new BackendBudget(limits),
    );
    const chain = { chainId: 143 } as never;
    await assert.rejects(client.listPools(chain), BackendBudgetExceeded);
    await assert.rejects(client.listSwapVM(chain), BackendBudgetExceeded);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("a client constructed without a budget still gets the conservative default", () => {
  const client = new AquaClient("https://staging-api.aqua0.xyz");
  assert.deepEqual(client.budget.status().search.limits, {
    ...DEFAULT_BUDGET_LIMITS.search,
  });
});
