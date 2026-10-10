import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, keccak256 } from "viem";
import { loadChains } from "../src/config.js";
import {
  pilotPolicySchema,
  readPilotState,
  fundingStep,
} from "../src/owner-pilot.js";
const p = pilotPolicySchema.parse(
  JSON.parse(readFileSync("config/arbitrum-pilot.json", "utf8")),
);
const artifact = JSON.parse(
  readFileSync("out/MarketRebalancer.sol/MarketRebalancer.json", "utf8"),
);
const c = createPublicClient({
  transport: http("https://arb1.arbitrum.io/rpc", {
    timeout: 15000,
    retryCount: 0,
  }),
});
const state = await readPilotState(
  c,
  p,
  loadChains().find((x) => x.chainId === 42161)!,
  artifact,
);
const step = await fundingStep(c, p, state);
if (!step)
  throw Error(
    "Executor already has its target inventory; do not generate another funding fixture",
  );
const routerCode = await c.getCode({
  address: p.fundingRouter,
  blockNumber: state.blockNumber,
});
if (!routerCode) throw Error("Missing router code");
const out = {
  policy: p,
  state,
  step,
  fundingRouterCodeHash: keccak256(routerCode),
  qualification:
    "Actual deployed owner, executor and external router on an in-process local fork. No mainnet transaction, key load or signature.",
};
writeFileSync(
  "config/owner-pilot-funding-fork.json",
  JSON.stringify(
    out,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ) + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    chainId: 42161,
    block: String(state.blockNumber),
    fundingValueWei: String(step.value),
    signatures: 0,
    transactions: 0,
  }),
);
