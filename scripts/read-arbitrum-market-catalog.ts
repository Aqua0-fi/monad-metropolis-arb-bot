import { readFileSync, lstatSync, writeFileSync } from "node:fs";
import { AquaClient } from "../src/aqua.js";
import { loadChains } from "../src/config.js";
import { validatePoolListing } from "../src/market-catalog.js";
import { validateSwapVMListing } from "../src/swapvm.js";

// New owner-requested read of the other available markets. No authorizations, signing or writes to the service.
const path =
  "/Users/rithikkumars/CodingStuff/Aqua0/secrets/market-rebalancer-observer.json";
const stat = lstatSync(path);
if (
  stat.isSymbolicLink() ||
  !stat.isFile() ||
  stat.uid !== process.getuid?.() ||
  (stat.mode & 0o777) !== 0o600
)
  throw new Error("Unsafe read-credential file");
const secret = JSON.parse(readFileSync(path, "utf8"));
if (typeof secret.AQUA0_READ_API_KEY !== "string")
  throw new Error("Missing dedicated read API credential");
const chain = loadChains().find((c) => c.chainId === 42161)!;
const api = new AquaClient("https://staging-api.aqua0.xyz", {
  "X-API-Key": secret.AQUA0_READ_API_KEY,
  "X-Network-Mode": "mainnet",
});
const v4Listing = await api.listPools(chain);
const v4 = validatePoolListing(chain, v4Listing);
const swapVMListing = await api.listSwapVM(chain);
const swapVM = validateSwapVMListing(chain, "mainnet", swapVMListing);
const result = {
  observedAt: new Date().toISOString(),
  chainId: 42161,
  v4,
  swapVM,
  v4Listing,
  swapVMListing,
  serviceWriteRequests: 0,
  signatures: 0,
  publicTransactions: 0,
};
writeFileSync(
  "../evidence/arbitrum-other-markets-20260929.json",
  JSON.stringify(
    result,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  ) + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify(
    {
      observedAt: result.observedAt,
      v4: v4.map((p) => ({
        poolId: p.pool.poolId,
        classIds: p.classIds,
        tokens: p.tokens,
        blockers: p.blockers,
      })),
      swapVM: swapVM.markets.map((m) => ({
        strategyId: m.stableStrategyId,
        classId: m.classId,
        tokens: m.tokens,
      })),
      unavailable: swapVM.unavailable,
      serviceWriteRequests: 0,
      publicTransactions: 0,
    },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  ),
);
