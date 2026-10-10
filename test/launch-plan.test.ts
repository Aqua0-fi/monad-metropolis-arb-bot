import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeFunctionData, parseAbi } from "viem";
import { loadChains } from "../src/config.js";
import { buildUnsignedArbitrumLaunch } from "../src/launch-plan.js";
const owner = "0x1111111111111111111111111111111111111111";
const chain = loadChains().find((c) => c.chainId === 42161)!;
const artifact = JSON.parse(
  readFileSync("out/MarketRebalancer.sol/MarketRebalancer.json", "utf8"),
);
test("launch package has an exact five-USDC ceiling and no activation, funding or signing action", () => {
  const p = buildUnsignedArbitrumLaunch({
    chain,
    artifact,
    owner,
    operator: owner,
    nonce: 0n,
    usdc: chain.pools[0]!.currency1,
    minGrossProfit: 10000n,
    gasPriceCap: 100000000n,
  });
  assert.equal(p.chainId, 42161);
  assert.equal(p.broadcast, false);
  assert.equal(p.mode, "observe");
  assert.equal(p.executorDeployed, false);
  assert.equal(p.inputCapRaw, "5000000");
  const abi = parseAbi([
    "function setOperator(address,bool)",
    "function setGasPriceLimit(uint256)",
    "function setLimits(address,uint256,uint256)",
  ]);
  const calls = p.ownerSetup.map((tx) =>
    decodeFunctionData({ abi, data: tx.data }),
  );
  assert.deepEqual(
    calls.map((c) => c.functionName),
    ["setOperator", "setGasPriceLimit", "setLimits"],
  );
  assert.equal(calls[2]!.args![1], 5000000n);
  assert.equal(
    p.ownerSetup.every((tx) => tx.value === "0"),
    true,
  );
  assert.equal(JSON.stringify(p).includes("setPaused"), false);
});
test("draft rejects unreviewed chains, negative nonces and zero policy limits", () => {
  const p: Parameters<typeof buildUnsignedArbitrumLaunch>[0] = {
    chain,
    artifact,
    owner,
    operator: owner,
    nonce: 0n,
    usdc: chain.pools[0]!.currency1,
    minGrossProfit: 10000n,
    gasPriceCap: 100000000n,
  };
  assert.throws(() =>
    buildUnsignedArbitrumLaunch({ ...p, chain: { ...chain, chainId: 8453 } }),
  );
  assert.throws(() => buildUnsignedArbitrumLaunch({ ...p, nonce: -1n }));
  assert.throws(() =>
    buildUnsignedArbitrumLaunch({ ...p, minGrossProfit: 0n }),
  );
});
