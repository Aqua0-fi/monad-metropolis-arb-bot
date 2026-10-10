import type { Hex, PublicClient } from "viem";
import {
  economicsReviewSchema,
  valuedCost,
  type EconomicsSnapshot,
} from "./economics.js";
import { HistoryStore } from "./history.js";
import { verifyEconomicAnchors } from "./economic-gate.js";
import { valueSettlementFees } from "./settlement-economics.js";

/** Explicit operator review, not ordinary Resume. It never modifies pair permissions, keys or funding. */
export async function reviewEconomicWindow(
  history: HistoryStore,
  network: "mainnet" | "fork",
  input: unknown,
  actor: string,
  clientForChain: (chainId: number) => PublicClient,
  now: () => number = Date.now,
): Promise<EconomicsSnapshot> {
  const change = economicsReviewSchema.parse(input);
  const before = history.economics(network);
  if (
    before.version !== change.expectedVersion ||
    before.throughSettlement !== change.throughSettlement
  )
    throw new Error(
      "Economic review version conflict; refresh before reviewing",
    );
  if (before.pending)
    throw new Error(
      "Pending transactions must be reconciled before economic review",
    );
  const deadline = now() + 5500;
  const checkTime = () => {
    if (now() > deadline)
      throw new Error(
        "Economic evidence check timed out; the pause was not cleared",
      );
  };
  const chainIds = new Set<number>();
  for (const record of history.economicRecords(network, before.reviewedThrough))
    chainIds.add(record.chainId);
  for (const chainId of chainIds) {
    checkTime();
    await verifyEconomicAnchors(
      history,
      network,
      chainId,
      clientForChain(chainId),
    );
    checkTime();
  }
  // Missing fee conversions may be retried from their original policy and exact receipt only.
  // Enrichment changes the version and requires the operator to see the new result before clearing it.
  for (const record of history.economicRecords(
    network,
    before.reviewedThrough,
  )) {
    if (!record.receipt || valuedCost(record) !== null) continue;
    checkTime();
    const client = clientForChain(record.chainId);
    const receipt = await client.getTransactionReceipt({
      hash: record.transactionHash as Hex,
    });
    if (
      receipt.transactionHash.toLowerCase() !==
        record.transactionHash.toLowerCase() ||
      receipt.blockHash.toLowerCase() !==
        record.receipt.blockHash.toLowerCase() ||
      receipt.blockNumber.toString() !== record.receipt.blockNumber ||
      receipt.from.toLowerCase() !== record.operator.toLowerCase() ||
      receipt.to?.toLowerCase() !== record.executor.toLowerCase() ||
      (receipt.status === "success" ? "confirmed" : "reverted") !==
        record.status
    ) {
      history.latchEconomics(network, "canonicality_changed");
      throw new Error(
        "Economic receipt identity changed; manual reconciliation required",
      );
    }
    const enriched = await valueSettlementFees(
      client,
      record,
      receipt,
      record.receipt,
    );
    checkTime();
    history.settle(
      network,
      record.chainId,
      record.transactionHash,
      record.status as "confirmed" | "reverted",
      enriched,
    );
    if (history.economics(network).version !== before.version)
      throw new Error(
        "Economic review version conflict: fee evidence updated; refresh and inspect the new values",
      );
  }
  checkTime();
  // The synchronous, versioned SQLite transaction also rejects any newly pending or unknown-cost record.
  return history.reviewEconomics(network, change, actor);
}
