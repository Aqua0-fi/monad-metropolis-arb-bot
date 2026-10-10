import type { PublicClient } from "viem";
import type { HistoryStore } from "./history.js";

export function assertEconomicExecution(
  history: HistoryStore | undefined,
  network: "mainnet" | "fork",
): asserts history is HistoryStore {
  if (!history)
    throw new Error("Durable execution history is required for trading");
  const status = history.economics(network);
  if (status.blocked)
    throw new Error(
      `Economic review required: ${status.reason ?? "unavailable"}`,
    );
}

interface CheckedAnchor {
  reviewedThrough: number;
  throughSettlement: number;
  number: string;
  hash: string;
}
const verified = new WeakMap<
  HistoryStore,
  WeakMap<PublicClient, Map<string, CheckedAnchor>>
>();
function clientAnchors(
  history: HistoryStore,
  client: PublicClient,
): Map<string, CheckedAnchor> {
  let clients = verified.get(history);
  if (!clients) {
    clients = new WeakMap();
    verified.set(history, clients);
  }
  let anchors = clients.get(client);
  if (!anchors) {
    anchors = new Map();
    clients.set(client, anchors);
  }
  return anchors;
}

/** Recheck the unreviewed receipt anchors only when a real trade is selected, not on every price poll. */
export async function verifyEconomicAnchors(
  history: HistoryStore,
  network: "mainnet" | "fork",
  chainId: number,
  client: PublicClient,
): Promise<void> {
  const before = history.economics(network);
  const anchors = clientAnchors(history, client);
  const key = `${network}:${chainId}`;
  const prior = anchors.get(key);
  const cached =
    prior?.reviewedThrough === before.reviewedThrough &&
    prior.throughSettlement <= before.throughSettlement
      ? prior
      : undefined;
  const blocks = new Map<string, string>();
  // A still-canonical block hash commits to the same already-verified ancestor blocks.
  // The anchor itself is always reread. New settlements, including late older receipts, are checked separately.
  if (cached) blocks.set(cached.number, cached.hash);
  for (const record of history.economicRecords(
    network,
    cached?.throughSettlement ?? before.reviewedThrough,
  )) {
    if (record.chainId !== chainId || !record.receipt) continue;
    const { blockNumber, blockHash } = record.receipt;
    const previous = blocks.get(blockNumber);
    if (previous && previous !== blockHash) {
      history.latchEconomics(network, "canonicality_changed");
      throw new Error(
        "Economic receipt anchors disagree; manual review required",
      );
    }
    blocks.set(blockNumber, blockHash);
  }
  if (blocks.size) {
    try {
      if ((await client.getChainId()) !== chainId)
        throw new Error("Network mismatch");
    } catch {
      anchors.delete(key);
      history.latchEconomics(network, "canonicality_unavailable");
      throw new Error("Economic receipt network cannot be verified");
    }
  }
  for (const [number, expected] of blocks) {
    let actual: string | null;
    try {
      actual = (await client.getBlock({ blockNumber: BigInt(number) })).hash;
    } catch {
      anchors.delete(key);
      history.latchEconomics(network, "canonicality_unavailable");
      throw new Error(
        "Economic receipt canonicality unavailable; manual review required",
      );
    }
    if (actual?.toLowerCase() !== expected.toLowerCase()) {
      anchors.delete(key);
      history.latchEconomics(network, "canonicality_changed");
      throw new Error(
        "Economic receipt canonicality changed; manual review required",
      );
    }
  }
  if (history.economics(network).version !== before.version)
    throw new Error(
      "Economic history changed during verification; refresh before trading",
    );
  let highest: [string, string] | undefined;
  for (const item of blocks)
    if (!highest || BigInt(item[0]) > BigInt(highest[0])) highest = item;
  if (highest) {
    anchors.set(key, {
      reviewedThrough: before.reviewedThrough,
      throughSettlement: before.throughSettlement,
      number: highest[0],
      hash: highest[1],
    });
    while (anchors.size > 128) anchors.delete(anchors.keys().next().value!);
  }
}
