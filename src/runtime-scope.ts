import type { ChainConfig, Settings } from "./config.js";
import type { Journal } from "./state.js";
export function runtimeScope(
  chains: ChainConfig[],
  settings: Settings,
  selection?: string,
): { chains: ChainConfig[]; settings: Settings } {
  const selected =
    selection === undefined
      ? chains
      : chains.filter((chain) => String(chain.chainId) === selection);
  if (selected.length === 0) throw new Error("Unknown chain selection");
  const ids = new Set(selected.map((chain) => chain.chainId));
  if (
    selection === undefined &&
    Object.keys(settings.execution).some((id) => !ids.has(Number(id)))
  )
    throw new Error(
      "Execution configuration includes a chain absent from the registry",
    );
  return {
    chains: selected,
    settings: {
      ...settings,
      markets: settings.markets.filter((m) => ids.has(m.chainId)),
      execution: Object.fromEntries(
        Object.entries(settings.execution).filter(([id]) =>
          ids.has(Number(id)),
        ),
      ),
    },
  };
}
/** A narrowed observer must not silently leave an uncertain send without reconciliation. */
export function assertPendingScope(
  journal: Journal,
  chains: ChainConfig[],
  settings: Settings,
): void {
  const ids = new Set(chains.map((c) => c.chainId));
  for (const account of journal.pendingAccounts()) {
    const match = /^([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/.exec(account);
    if (!match)
      throw new Error(
        "A pending journal account has an unknown identity; reconcile it before startup",
      );
    const chainId = Number(match[1]);
    if (!ids.has(chainId))
      throw new Error(
        `Pending transaction on chain ${chainId} must be reconciled before narrowing the worker`,
      );
    if (
      settings.execution[chainId]?.operator.toLowerCase() !==
      match[2]!.toLowerCase()
    )
      throw new Error(
        `Pending transaction on chain ${chainId} requires its existing operator configuration`,
      );
  }
}

/** Lazy read-only clients for explicit historical receipt review, never discovery or signing. */
export function receiptReviewClients(
  registered: ChainConfig[],
  makeClient: (chain: ChainConfig) => import("viem").PublicClient,
): (chainId: number) => import("viem").PublicClient {
  const clients = new Map<number, import("viem").PublicClient>();
  return (chainId) => {
    const chain = registered.find((entry) => entry.chainId === chainId);
    if (!chain) throw new Error("Unknown receipt-review chain");
    let client = clients.get(chainId);
    if (!client) {
      client = makeClient(chain);
      clients.set(chainId, client);
    }
    return client;
  };
}
