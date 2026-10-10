import type { AquaClient } from "./aqua.js";
import type { ChainConfig } from "./config.js";
import type { MarketCatalog } from "./market-catalog.js";

/** Two read requests at a time. No signing, reservations, approvals or automatic policy changes. */
export async function refreshPublicMarkets(
  chains: readonly ChainConfig[],
  aqua: Pick<AquaClient, "listPools">,
  catalog: MarketCatalog,
) {
  let next = 0,
    succeeded = 0,
    failed = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, chains.length) }, async () => {
      while (next < chains.length) {
        const chain = chains[next++];
        if (!chain) break;
        try {
          catalog.recordListing(chain, await aqua.listPools(chain));
          succeeded++;
        } catch (error) {
          catalog.recordFailure(
            chain.chainId,
            error instanceof Error ? error.message : "Public discovery failed",
          );
          failed++;
        }
      }
    }),
  );
  return { succeeded, failed };
}
