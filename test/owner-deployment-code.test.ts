import test from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "viem";
import {
  normalizeRuntime,
  assertCreationBudget,
} from "../src/owner-deployment.js";
test("runtime comparison masks only compiler-declared immutable slots", () => {
  const artifact = {
    object: "0x112233445566" as const,
    immutableReferences: { "1": [{ start: 2, length: 2 }] },
  };
  assert.equal(
    normalizeRuntime("0x1122ffff5566", artifact),
    normalizeRuntime(artifact.object, artifact),
  );
  assert.notEqual(
    normalizeRuntime("0x9922ffff5566", artifact),
    normalizeRuntime(artifact.object, artifact),
  );
  assert.throws(() => normalizeRuntime("0x1122", artifact));
  assert.throws(() =>
    normalizeRuntime(artifact.object, {
      ...artifact,
      immutableReferences: { "1": [{ start: 3, length: 9 }] },
    }),
  );
});
test("creation budget rejects unreviewed destinations, values and excessive maximum fees", () => {
  const tx = {
    type: "eip1559" as const,
    chainId: 42161,
    nonce: 0,
    gas: 100000n,
    maxFeePerGas: 100000000n,
    maxPriorityFeePerGas: 0n,
    value: 0n,
    data: "0x60006000f3" as const,
  };
  assert.doesNotThrow(() => assertCreationBudget(tx, 20000000000000n));
  assert.throws(() =>
    assertCreationBudget(
      { ...tx, to: "0x1111111111111111111111111111111111111111" },
      20000000000000n,
    ),
  );
  assert.throws(() =>
    assertCreationBudget({ ...tx, value: 1n }, 20000000000000n),
  );
  assert.throws(() => assertCreationBudget(tx, 1n));
  assert.throws(() =>
    assertCreationBudget({ ...tx, chainId: 8453 }, 20000000000000n),
  );
});
