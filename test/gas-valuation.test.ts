import test from "node:test";
import assert from "node:assert/strict";
import { zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { createNativeFeeValuer } from "../src/gas-valuation.js";
import { loadChains } from "../src/config.js";
const address = (n: number) =>
  `0x${n.toString(16).padStart(40, "0")}` as Address;
const base = address(1),
  wrapped = address(2),
  factory = address(3),
  quoter = address(4);
const block = { number: 800n, hash: `0x${"cd".repeat(32)}` as Hex };
const chain = {
  ...loadChains().find((c) => c.chainId === 42161)!,
  nativeEquivalent: { token: wrapped, decimals: 18 },
  venues: [{ name: "reviewed-v3", factory, quoter, fees: [100, 500, 3000] }],
};
function harness() {
  const quoted: any[] = [];
  let factoryReads = 0;
  const client = {
    getBlock: async () => block,
    readContract: async (r: any) => {
      assert.equal(r.blockNumber, block.number);
      switch (r.functionName) {
        case "decimals":
          return r.address === base ? 6 : 18;
        case "factory":
          return r.address === address(3000) ? address(999) : factory;
        case "getPool":
          factoryReads++;
          return address(r.args[2]);
        case "token0":
          return base;
        case "token1":
          return wrapped;
        case "fee":
          return Number(BigInt(r.address));
        default:
          throw Error("Unexpected read");
      }
    },
    simulateContract: async (r: any) => {
      assert.equal(r.functionName, "quoteExactOutputSingle");
      assert.equal(r.blockNumber, block.number);
      assert.equal(r.args[0].tokenIn, base);
      assert.equal(r.args[0].tokenOut, wrapped);
      quoted.push(r.args[0]);
      return { result: [r.args[0].fee === 100 ? 30n : 25n, 0n, 0, 0n] };
    },
  } as unknown as PublicClient;
  return { client, quoted, factoryReads: () => factoryReads };
}

test("gas replacement uses a real exact-output quote and verified discovered fee tiers", async () => {
  const h = harness();
  const value = createNativeFeeValuer(h.client, chain, wrapped, base, block);
  const result = await value(1000n);
  assert.deepEqual(result, {
    tokenCost: 25n,
    conversionPool: address(500),
    conversionQuoter: quoter,
    conversionFee: 500,
  });
  assert.deepEqual(h.quoted.map((q) => q.fee).sort(), [100, 500]);
  assert.ok(h.quoted.every((q) => q.amount === 1000n));
  await value(1200n);
  assert.equal(
    h.factoryReads(),
    3,
    "Reuse only same-block verified identities within a fee refinement",
  );
  assert.ok(
    h.quoted.slice(2).every((q) => q.amount === 1200n),
    "Requote the new actual cost, never reuse an old price",
  );
});

test("failed conversions, unknown metadata and forged pool identities do not become zero fees", async () => {
  const h = harness();
  h.client.simulateContract = (async () => {
    throw Error("unavailable");
  }) as any;
  await assert.rejects(
    () => createNativeFeeValuer(h.client, chain, wrapped, base, block)(1000n),
    /unavailable/,
  );
  const forged = harness();
  forged.client.readContract = (async (r: any) =>
    r.functionName === "decimals"
      ? 18
      : r.functionName === "factory"
        ? zeroAddress
        : address(100)) as any;
  await assert.rejects(
    () =>
      createNativeFeeValuer(forged.client, chain, wrapped, base, block)(1000n),
    /verified/,
  );
  assert.equal(forged.quoted.length, 0);
  const wrong = harness();
  wrong.client.readContract = (async () => 6) as any;
  await assert.rejects(
    () =>
      createNativeFeeValuer(wrong.client, chain, wrapped, base, block)(1000n),
    /decimals/,
  );
});

test("an unavailable tier can use a genuinely quoted reviewed alternative, never an invented price", async () => {
  const h = harness();
  const original = h.client.simulateContract;
  h.client.simulateContract = (async (r: any) => {
    if (r.args[0].fee === 100) throw Error("one venue unavailable");
    return original(r);
  }) as any;
  const result = await createNativeFeeValuer(
    h.client,
    chain,
    wrapped,
    base,
    block,
  )(1000n);
  assert.equal(result.tokenCost, 25n);
  assert.equal(result.conversionPool, address(500));
});

test("the route's own verified gas/base pool avoids an unrelated fee-tier discovery on every candidate", async () => {
  const h = harness();
  const value = createNativeFeeValuer(
    h.client,
    chain,
    wrapped,
    base,
    block,
    address(100),
  );
  const first = await value(1000n);
  await value(1200n);
  assert.equal(first.tokenCost, 30n);
  assert.equal(first.conversionPool, address(100));
  assert.equal(h.factoryReads(), 1);
  assert.deepEqual(
    h.quoted.map((q) => q.fee),
    [100, 100],
  );
  assert.deepEqual(
    h.quoted.map((q) => q.amount),
    [1000n, 1200n],
  );
});

test("a preferred conversion pool must prove its own factory, tokens, tier and factory lookup", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      createNativeFeeValuer(
        h.client,
        chain,
        wrapped,
        base,
        block,
        address(3000),
      )(1000n),
    /verified|identity|reviewed/i,
  );
  assert.equal(h.quoted.length, 0);
});
