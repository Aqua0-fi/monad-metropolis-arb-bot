import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import {
  buildUnsignedProfitReturn,
  profitReturnAbi,
} from "../src/profit-return-plan.js";
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const fixture = () => ({
  version: 1,
  scope: "hackathon-only",
  state: "ready_for_owner_review",
  network: "fork",
  chainId: 42161,
  token: a(3),
  executor: a(4),
  netProfit: "100",
  returnAmount: "90",
  evidenceHash: `0x${"ab".repeat(32)}`,
  payoutStatus: "not_submitted",
  executionHashes: [`0x${"cd".repeat(32)}`],
  allocations: [{ lp: a(10), amount: "90" }],
});
test("unsigned proposal encodes exact reviewed values without any signed payload", () => {
  const p = buildUnsignedProfitReturn(fixture(), a(1), a(2));
  assert.equal(p.broadcast, false);
  assert.equal(p.signaturesProduced, 0);
  const c = decodeFunctionData({
    abi: profitReturnAbi,
    data: p.transactions[1]!.data,
  });
  assert.equal(c.functionName, "distribute");
  assert.equal(c.args![2], 100n);
  assert.deepEqual(c.args![4], [90n]);
});
test("rejects forged totals, duplicated receipts and an already paid state", () => {
  const f = fixture();
  assert.throws(() =>
    buildUnsignedProfitReturn({ ...f, returnAmount: "100" }, a(1), a(2)),
  );
  assert.throws(() =>
    buildUnsignedProfitReturn(
      { ...f, executionHashes: [...f.executionHashes, ...f.executionHashes] },
      a(1),
      a(2),
    ),
  );
  assert.throws(() =>
    buildUnsignedProfitReturn({ ...f, payoutStatus: "paid" }, a(1), a(2)),
  );
});
