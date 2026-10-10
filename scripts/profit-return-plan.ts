import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getAddress } from "viem";
import { buildUnsignedProfitReturn } from "../src/profit-return-plan.js";
const { values } = parseArgs({
  options: {
    proposal: { type: "string" },
    owner: { type: "string" },
    distributor: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.proposal || !values.owner || !values.distributor || !values.output)
  throw new Error("Supply --proposal, --owner, --distributor and --output");
const raw = readFileSync(values.proposal, "utf8");
if (raw.length > 500000) throw new Error("Oversized proposal");
const draft = buildUnsignedProfitReturn(
  JSON.parse(raw),
  getAddress(values.owner),
  getAddress(values.distributor),
);
writeFileSync(values.output, JSON.stringify(draft, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
console.log(
  "Saved unsigned approval and return calldata. No keys, RPC writes, signatures or transactions were used.",
);
