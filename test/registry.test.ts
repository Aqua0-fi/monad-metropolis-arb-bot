import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChainRegistry,
  registryBlockers,
  type CanonicalChain,
} from "../src/registry.js";
import { chainSchema, loadChains } from "../src/config.js";
const old = loadChains().find((c) => c.chainId === 8453)!;
const canonical: CanonicalChain = {
  ...old,
  nativeCurrency: { symbol: "ETH", decimals: 18 },
  tokens: [],
};
const policy = {
  feeModel: "op-stack" as const,
  extendedV4Encoding: false,
  reviewed: true,
  venues: old.venues,
};

test("canonical protocol addresses replace stale snapshots without approving newly registered chains", () => {
  const changed = {
    ...canonical,
    aqua0Hook: "0x1111111111111111111111111111111111111111" as const,
  };
  const [updated, newChain] = buildChainRegistry(
    [changed, { ...canonical, chainId: 999 }],
    { "8453": policy },
  );
  assert.equal(updated?.aqua0Hook.toLowerCase(), changed.aqua0Hook);
  assert.equal(updated?.rpcEnv, canonical.rpcEnv);
  assert.equal(newChain?.executionReviewed, false);
  assert.equal(newChain?.feeModel, "unsupported");
  assert.ok(
    registryBlockers(newChain!).includes(
      "No supported external venue configured",
    ),
  );
});
test("native and ERC20 gas-unit representations remain distinct and missing token identity is rejected", () => {
  const token = "0x3600000000000000000000000000000000000000" as const;
  const arc = {
    ...canonical,
    chainId: 5042,
    pools: [],
    nativeCurrency: { symbol: "USDC", decimals: 18 },
    tokens: [{ symbol: "USDC", address: token, decimals: 6 }],
  };
  const policies = {
    "5042": {
      ...policy,
      feeModel: "gas-limit" as const,
      reviewed: false,
      venues: [],
      nativeEquivalentSymbol: "usdc",
    },
  };
  const [row] = buildChainRegistry([arc], policies);
  assert.equal(row?.nativeCurrency?.decimals, 18);
  assert.equal(row?.nativeEquivalent?.decimals, 6);
  assert.ok(
    registryBlockers(row!).includes(
      "Canonical registry has no configured V4 pool",
    ),
  );
  assert.throws(
    () => buildChainRegistry([{ ...arc, tokens: [] }], policies),
    /missing from canonical/,
  );
  assert.throws(
    () => buildChainRegistry([arc, arc], policies),
    /Duplicate canonical/,
  );
});

// A legacy or hand-written row is not an explicit execution review.
test("omitting execution review never enables a chain", () => {
  const unreviewed = chainSchema.parse({
    ...old,
    executionReviewed: undefined,
  });
  assert.equal(unreviewed.executionReviewed, false);
  assert.ok(
    registryBlockers(unreviewed).some((reason) =>
      reason.includes("not been reviewed"),
    ),
  );
});

test("native fee conversion refuses ambiguous canonical token symbols", () => {
  const ambiguous = {
    ...canonical,
    tokens: [
      {
        symbol: "USDC",
        address: "0x1111111111111111111111111111111111111111" as const,
        decimals: 6,
      },
      {
        symbol: "usdc",
        address: "0x2222222222222222222222222222222222222222" as const,
        decimals: 18,
      },
    ],
  };
  assert.throws(
    () =>
      buildChainRegistry([ambiguous], {
        "8453": { ...policy, nativeEquivalentSymbol: "USDC" },
      }),
    /ambiguous/i,
  );
});
