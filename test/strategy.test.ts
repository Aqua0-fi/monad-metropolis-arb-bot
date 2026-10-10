import test from "node:test";
import assert from "node:assert/strict";
import {
  findCandidates,
  haircut,
  ceilDiv,
  assertFresh,
} from "../src/strategy.js";
import { loadChains, findPool, settingsSchema, zero } from "../src/config.js";
import { validateQuote } from "../src/aqua.js";
const chain = loadChains().find((c) => c.chainId === 8453)!;
const pool = chain.pools[0]!;
const base = {
  base: pool.currency0,
  other: pool.currency1,
  pool,
  router: chain.universalRouter,
  external: chain.venues[0]!.factory,
  amounts: [1000n],
  slippageBps: 10,
  minNetProfit: 10n,
  gasCost: 5n,
  blockNumber: 100n,
  timestamp: 1000n,
};
test("evaluates both cycle directions and protects intermediate amount", async () => {
  const candidates = await findCandidates({
    ...base,
    quoteAqua: async (_, n) => n * 2n,
    quoteExternal: async (_, n) => (n * 6n) / 10n,
  });
  assert.equal(candidates.length, 2);
  for (const c of candidates) {
    assert.equal(c.trade.minProfit, 15n);
    assert(c.trade.second.minOut >= c.trade.first.amountIn + 15n);
    assert(c.trade.first.minOut === c.trade.second.amountIn);
  }
});
test("rejects spread smaller than fees and gas", async () => {
  assert.equal(
    (
      await findCandidates({
        ...base,
        quoteAqua: async (_, n) => n + 5n,
        quoteExternal: async (_, n) => n,
      })
    ).length,
    0,
  );
});
test("uses bigints beyond Number.MAX_SAFE_INTEGER", () => {
  assert.equal(haircut(10n ** 30n, 25), 9975n * 10n ** 26n);
  assert.equal(ceilDiv(101n, 100n), 2n);
});
test("one bad size does not suppress good sizes", async () => {
  let errors = 0;
  const result = await findCandidates({
    ...base,
    amounts: [1n, 1000n],
    quoteAqua: async (_, n) => {
      if (n < 10n) throw new Error("too small");
      return 2n * n;
    },
    quoteExternal: async (_, n) => n,
    onQuoteError: () => errors++,
  });
  assert(result.length > 0);
  assert(errors > 0);
});
test("stale time, stale block, and backwards heads rejected", async () => {
  const [c] = await findCandidates({
    ...base,
    quoteAqua: async (_, n) => 2n * n,
    quoteExternal: async (_, n) => n,
  });
  assert(c);
  assert.throws(() => assertFresh(c, 100n, c.quotedAt + 10001, 10000, 1));
  assert.throws(() => assertFresh(c, 102n, c.quotedAt, 10000, 1));
  assert.throws(() => assertFresh(c, 99n, c.quotedAt, 10000, 1));
  assertFresh(c, 101n, c.quotedAt + 100, 10000, 1);
});
test("quote clamps, incorrect amounts, and token mismatches fail closed", () => {
  const q = {
    quote: {
      amountIn: "1000",
      amountOut: "1100",
      amountInToken: pool.currency0,
      amountOutToken: pool.currency1,
      execution: {
        requestedAmountIn: "1000",
        authorizedAmountIn: "1000",
        authorizedAmountOut: "1090",
        fullySupported: true,
        wasClamped: false,
      },
    },
  };
  assert.equal(validateQuote(q, pool.currency0, pool.currency1, 1000n), 1090n);
  assert.throws(() => validateQuote(q, pool.currency0, pool.currency1, 999n));
  assert.throws(() => validateQuote(q, pool.currency1, pool.currency0, 1000n));
  q.quote.execution.wasClamped = true;
  assert.throws(() => validateQuote(q, pool.currency0, pool.currency1, 1000n));
});
test("registry separates canonical chain presence from executable venue support", () => {
  const chains = loadChains();
  assert.ok(chains.length > 0);
  assert.equal(new Set(chains.map((c) => c.chainId)).size, chains.length);
  for (const c of chains) {
    assert.notEqual(c.aqua0Hook, zero);
    assert(c.venues.every((v) => v.factory !== zero && v.quoter !== zero));
    if (c.executionReviewed) {
      assert.ok(
        c.venues.length > 0,
        `${c.name}: reviewed execution needs an external venue`,
      );
      assert.ok(
        c.pools.length > 0,
        `${c.name}: reviewed execution needs a protocol pool`,
      );
      assert.notEqual(c.feeModel, "unsupported");
    }
  }
});
test("market cannot substitute a different pool or base asset", () => {
  assert.throws(() =>
    findPool(chain, {
      chainId: chain.chainId,
      poolId: pool.poolId,
      classId: 1n,
      baseToken: zero,
      amounts: [1n],
      minNetProfit: 1n,
      maxInput: 1n,
    }),
  );
});
test("execution is opt-in and malformed config fails", () => {
  assert.throws(() => settingsSchema.parse({ mode: "execute", markets: [] }));
});
