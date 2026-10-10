import test from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { assertAdditionalFeeReserve } from "../src/fees.js";
import { loadChains } from "../src/config.js";
const chain = loadChains().find((c) => c.chainId === 8453)!;
const tx = {
  to: chain.universalRouter,
  data: "0x1234" as const,
  gas: 1000000n,
  gasPrice: 10000000n,
  nonce: 1,
};
test("OP fee check includes both L1 and operator fees with buffer", async () => {
  const client = {
    readContract: async (p: { functionName: string }) =>
      p.functionName === "getL1Fee" ? 100n : 20n,
  } as unknown as PublicClient;
  await assertAdditionalFeeReserve(client, chain, tx, 156n, 13000);
  await assert.rejects(
    () => assertAdditionalFeeReserve(client, chain, tx, 155n, 13000),
    /fees exceed/,
  );
});
test("fee oracle outage fails closed", async () => {
  const client = {
    readContract: async () => {
      throw new Error("unavailable");
    },
  } as unknown as PublicClient;
  await assert.rejects(() =>
    assertAdditionalFeeReserve(client, chain, tx, 1000n, 13000),
  );
});

test("native stablecoin gas is converted to ERC20 units conservatively instead of quoting wei as micro-units", async () => {
  const { nativeCostForQuote } = await import("../src/fees.js");
  const token = "0x3600000000000000000000000000000000000000" as const;
  const arc = {
    ...chain,
    nativeCurrency: { symbol: "USDC", decimals: 18 },
    nativeEquivalent: { token, decimals: 6 },
  };
  assert.deepEqual(nativeCostForQuote(arc, token, 1000000000000000000n), {
    token,
    amount: 1000000n,
  });
  assert.equal(nativeCostForQuote(arc, token, 1n).amount, 1n);
  assert.equal(nativeCostForQuote(arc, token, 0n).amount, 0n);
  assert.throws(
    () => nativeCostForQuote(arc, chain.poolManager, 1n),
    /does not match/,
  );
  assert.equal(nativeCostForQuote(chain, chain.poolManager, 123n).amount, 123n);
  const unsupported = { ...chain, feeModel: "unsupported" as const };
  await assert.rejects(
    () =>
      assertAdditionalFeeReserve(
        {} as PublicClient,
        unsupported,
        tx,
        0n,
        13000,
      ),
    /unsupported/,
  );
});
