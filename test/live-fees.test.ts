import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { executorAbi } from "../src/abi.js";
import { loadChains } from "../src/config.js";
import type { Candidate } from "../src/strategy.js";
import { finalizeCandidateFees, type LiveFeePolicy } from "../src/live-fees.js";

const token = "0x1111111111111111111111111111111111111111" as Address;
const executor = "0x2222222222222222222222222222222222222222" as Address;
const operator = "0x3333333333333333333333333333333333333333" as Address;
const hash = `0x${"ab".repeat(32)}` as Hex;
const block = { number: 100n, hash };
const chain = {
  ...loadChains().find((c) => c.chainId === 42161)!,
  nativeEquivalent: { token, decimals: 18 },
};
const policy: LiveFeePolicy = {
  executor,
  operator,
  maxGasUnits: 5_000_000n,
  maxFeePerGas: 100n,
  l1FeeReserveWei: 999_999n,
  wrappedNative: token,
  liveFeeBufferBps: 10500,
};
function candidate(): Candidate {
  const leg = {
    venue: 1 as const,
    target: executor,
    tokenIn: token,
    tokenOut: token,
    amountIn: 1000n,
    minOut: 3000n,
    pool: {
      currency0: token,
      currency1: executor,
      fee: 100,
      tickSpacing: 1,
      hooks: executor,
    },
    hookData: "0x" as Hex,
  };
  return {
    quotedAt: Date.now(),
    blockNumber: block.number,
    quoteBlockHash: hash,
    quotedProfit: 2000n,
    netProfit: 2000n,
    minimumNetProfit: 100n,
    aquaFirst: true,
    trade: {
      id: hash,
      deadline: 1000n,
      validUntilBlock: 110n,
      minProfit: 100n,
      first: { ...leg },
      second: { ...leg },
    },
  };
}
function harness(gas: (minimum: bigint) => bigint = () => 11n) {
  const estimates: {
    floor: bigint;
    block: bigint;
    gasPrice: bigint;
    data: Hex;
  }[] = [];
  const simulations: unknown[] = [];
  const client = {
    getChainId: async () => chain.chainId,
    getGasPrice: async () => 20n,
    getBlock: async () => block,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "decimals") return 18;
      if (functionName === "getL1Fee") return 20n;
      if (functionName === "getOperatorFee") return 3n;
      throw Error(`Unexpected read ${functionName}`);
    },
    estimateGas: async (request: any) => {
      const decoded = decodeFunctionData({
        abi: executorAbi,
        data: request.data,
      });
      const floor = (decoded.args![0] as { minProfit: bigint }).minProfit;
      estimates.push({
        floor,
        block: request.blockNumber,
        gasPrice: request.gasPrice,
        data: request.data,
      });
      return gas(floor);
    },
    simulateContract: async (request: any) => {
      assert.equal(request.functionName, "execute");
      assert.equal(request.blockNumber, block.number);
      assert.equal(request.account, operator);
      simulations.push(request);
      return { result: 2000n };
    },
  } as unknown as PublicClient;
  return { client, estimates, simulations };
}

test("exact RPC gas and live price plus five percent replace configured ceilings as the cost", async () => {
  const h = harness();
  const c = candidate();
  const result = await finalizeCandidateFees(
    h.client,
    chain,
    policy,
    c,
    block,
    0,
    1n,
    100n,
  );
  assert.equal(result.gas, 11n);
  assert.equal(result.gasPrice, 21n);
  assert.equal(result.additionalNative, 0n);
  assert.equal(result.nativeCost, 231n);
  assert.equal(result.tokenCost, 231n);
  assert.equal(c.trade.minProfit, 331n);
  assert.equal(c.netProfit, 1769n);
  assert.equal(c.feeEstimate?.calldataHash, result.calldataHash);
  assert.equal(h.estimates.length, 2, "Changed calldata must be re-estimated");
  assert.ok(h.estimates.every((r) => r.block === 100n && r.gasPrice === 21n));
  assert.equal(h.simulations.length, 1);
});

test("a changed profit-floor encoding is re-estimated until the exact final call is covered", async () => {
  const h = harness((floor) => (floor < 300n ? 11n : 13n));
  const c = candidate();
  const r = await finalizeCandidateFees(
    h.client,
    chain,
    policy,
    c,
    block,
    2,
    1n,
    100n,
  );
  assert.deepEqual(
    h.estimates.map((x) => x.floor),
    [100n, 331n, 373n],
  );
  assert.equal(r.gas, 13n);
  assert.equal(c.trade.minProfit, 373n);
  assert.equal(c.netProfit, 1727n);
});

test("OP additional fees come from the actual transaction oracle, not the reserve ceiling", async () => {
  const h = harness();
  const c = candidate();
  const r = await finalizeCandidateFees(
    h.client,
    { ...chain, feeModel: "op-stack" },
    policy,
    c,
    block,
    0,
    1n,
    100n,
  );
  assert.equal(
    r.additionalNative,
    25n,
    "23 oracle units with a rounded-up five percent buffer",
  );
  assert.equal(r.nativeCost, 256n);
  assert.equal(c.trade.minProfit, 356n);
});

test("price and gas ceilings reject rather than replacing measured values", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      finalizeCandidateFees(
        h.client,
        chain,
        { ...policy, maxFeePerGas: 20n },
        candidate(),
        block,
        0,
        1n,
        100n,
      ),
    /gas price cap/i,
  );
  assert.equal(h.estimates.length, 0);
  await assert.rejects(
    () =>
      finalizeCandidateFees(
        h.client,
        chain,
        { ...policy, maxGasUnits: 10n },
        candidate(),
        block,
        0,
        1n,
        100n,
      ),
    /gas unit cap/i,
  );
});

test("unknown fee state, zero gas, lost margin and changed canonical blocks fail closed", async () => {
  const zero = harness(() => 0n);
  await assert.rejects(
    () =>
      finalizeCandidateFees(
        zero.client,
        chain,
        policy,
        candidate(),
        block,
        0,
        1n,
        100n,
      ),
    /gas estimate/i,
  );
  const expensive = harness(() => 100n);
  await assert.rejects(
    () =>
      finalizeCandidateFees(
        expensive.client,
        chain,
        policy,
        candidate(),
        block,
        0,
        1n,
        100n,
      ),
    /profit.*fees|fees.*profit/i,
  );
  const changed = harness();
  changed.client.getBlock = (async () => ({
    ...block,
    hash: `0x${"cd".repeat(32)}`,
  })) as any;
  await assert.rejects(
    () =>
      finalizeCandidateFees(
        changed.client,
        chain,
        policy,
        candidate(),
        block,
        0,
        1n,
        100n,
      ),
    /reorg|canonical/i,
  );
  const oracle = harness();
  oracle.client.readContract = (async () => {
    throw Error("oracle unavailable");
  }) as any;
  await assert.rejects(() =>
    finalizeCandidateFees(
      oracle.client,
      { ...chain, feeModel: "op-stack" },
      policy,
      candidate(),
      block,
      0,
      1n,
      100n,
    ),
  );
});

test("wrong native representation and non-converging estimates never acquire a trusted fee label", async () => {
  const h = harness();
  const c = candidate();
  await assert.rejects(
    () =>
      finalizeCandidateFees(
        h.client,
        chain,
        { ...policy, wrappedNative: executor },
        c,
        block,
        0,
        1n,
        100n,
      ),
    /native|equivalent/i,
  );
  assert.equal(c.feeEstimate, undefined);
  const evolving = harness((floor) => floor / 21n + 1n);
  await assert.rejects(
    () =>
      finalizeCandidateFees(
        evolving.client,
        chain,
        policy,
        candidate(),
        block,
        0,
        1n,
        100n,
      ),
    /converg|refinement/i,
  );
});

test("a refreshed estimate does not preserve an obsolete fee-inclusive profit floor", async () => {
  const h = harness();
  const c = candidate();
  c.trade.minProfit = 1500n;
  const result = await finalizeCandidateFees(
    h.client,
    chain,
    policy,
    c,
    block,
    0,
    1n,
    100n,
  );
  assert.equal(result.tokenCost, 231n);
  assert.equal(c.trade.minProfit, 331n);
  assert.equal(c.netProfit, 1769n);
});

test("freshness follows the exact simulated transaction, not the superseded search quote", async () => {
  const { assertFeeEstimateFresh } = await import("../src/live-fees.js");
  const h = harness(),
    c = candidate();
  const proof = await finalizeCandidateFees(
    h.client,
    chain,
    policy,
    c,
    block,
    0,
    1n,
    100n,
  );
  c.blockNumber = 1n;
  c.quotedAt = 0;
  assert.doesNotThrow(() =>
    assertFeeEstimateFresh(
      proof,
      c,
      { number: 107n, hash },
      Date.now(),
      10000,
      8,
    ),
  );
  assert.throws(
    () =>
      assertFeeEstimateFresh(
        proof,
        c,
        { number: 109n, hash },
        Date.now(),
        10000,
        8,
      ),
    /stale/i,
  );
  assert.throws(
    () =>
      assertFeeEstimateFresh(
        proof,
        c,
        block,
        proof.observedAt + 10001,
        10000,
        8,
      ),
    /stale/i,
  );
  assert.throws(
    () =>
      assertFeeEstimateFresh(
        proof,
        c,
        { ...block, hash: `0x${"cc".repeat(32)}` },
        Date.now(),
        10000,
        8,
      ),
    /reorg/i,
  );
  c.trade.second.minOut += 1n;
  assert.throws(
    () => assertFeeEstimateFresh(proof, c, block, Date.now(), 10000, 8),
    /changed/i,
  );
});
