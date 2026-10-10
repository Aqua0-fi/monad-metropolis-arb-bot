import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptOptimizedCandidates,
  type SizingRequest,
} from "../src/sizing.js";
import { loadChains, type Market } from "../src/config.js";
const chain = loadChains().find((c) => c.chainId === 8453)!;
const pool = chain.pools[0]!;
const external = {
  address: "0x00000000000000000000000000000000000000aa" as const,
  fee: 500,
  venue: chain.venues[0]!,
};
const market: Market = {
  chainId: chain.chainId,
  poolId: pool.poolId,
  classId: 2n,
  baseToken: pool.currency0,
  amounts: [],
  maxInput: 100n,
  minNetProfit: 2n,
};
const request: SizingRequest = {
  chain,
  pool,
  market,
  external,
  network: "fork",
  maxInput: 100n,
  gasBudget: 10n,
  slippageBps: 10,
  quotedAt: 1234,
};
const response = () => ({
  version: 1,
  venue: "v4",
  network: "fork",
  chainId: 8453,
  poolId: pool.poolId,
  classId: "2",
  baseToken: pool.currency0,
  externalPool: external.address,
  externalFactory: external.venue.factory,
  externalFee: 500,
  maxInput: "100",
  minNetProfit: "2",
  gasBudget: "10",
  blockNumber: "1000",
  blockHash: `0x${"aa".repeat(32)}`,
  blockTimestamp: "1000",
  transactionSimulated: false,
  reservationsCreated: false,
  quoteKind: "native-standard-v4-jit-projection-and-v3",
  candidates: [
    {
      aquaFirst: true,
      amountIn: "73",
      firstAmountOut: "150",
      secondAmountIn: "149",
      finalAmountOut: "86",
      grossProfit: "13",
      netProfit: "3",
    },
  ],
  searches: [
    {
      aquaFirst: true,
      method: "concentrated-liquidity-marginal-bracket",
      evaluatedInputs: 42,
      curveEvaluations: 84,
      sizingMs: 0.8,
    },
  ],
  excluded: [],
});

test("automatic sizing accepts an evaluated non-grid amount and constructs unchanged guarded two-leg calldata", () => {
  const result = acceptOptimizedCandidates(response(), request);
  const candidate = result.candidates[0]!;
  assert.equal(candidate.trade.first.amountIn, 73n);
  assert.equal(candidate.trade.second.amountIn, 149n);
  assert.equal(candidate.trade.first.minOut, 149n);
  assert.equal(candidate.trade.second.minOut, 86n);
  assert.equal(candidate.trade.minProfit, 12n);
  assert.equal(candidate.netProfit, 3n);
  assert.equal(candidate.quotedAt, 1234);
  assert.equal(candidate.quoteBlockHash, response().blockHash);
  assert.equal(candidate.trade.first.venue, 0);
  assert.equal(candidate.trade.second.venue, 1);
});
test("wrong network, market identity, factory or fee budget cannot become an executable candidate", () => {
  for (const changed of [
    { network: "mainnet" },
    { chainId: 42161 },
    { classId: "3" },
    { externalFactory: external.address },
    { gasBudget: "0" },
    { maxInput: "101" },
  ]) {
    assert.throws(() =>
      acceptOptimizedCandidates({ ...response(), ...changed }, request),
    );
  }
});
test("tampered or partial optimized amounts fail the independent profit and capacity checks", () => {
  for (const changed of [
    { amountIn: "101" },
    { secondAmountIn: "150" },
    { netProfit: "999" },
    { grossProfit: "50" },
    { finalAmountOut: "74" },
  ]) {
    const value = response();
    value.candidates[0] = { ...value.candidates[0]!, ...changed };
    assert.throws(() => acceptOptimizedCandidates(value, request));
  }
  const duplicated = response();
  duplicated.candidates.push(duplicated.candidates[0]!);
  assert.throws(
    () => acceptOptimizedCandidates(duplicated, request),
    /Duplicate/,
  );
});
test("a valid no-opportunity search does not invent a trade or force a default sample size", () => {
  const value = response();
  value.candidates = [];
  assert.deepEqual(acceptOptimizedCandidates(value, request).candidates, []);
});
