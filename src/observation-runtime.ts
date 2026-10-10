import { createPublicClient, http, type PublicClient } from "viem";
import { rpcUrl, type ChainConfig, type Settings } from "./config.js";
import { ObservationStore } from "./observations.js";
import { startBalanceObserver } from "./balance-observer.js";

/** Read-only diagnostics, independent of the transaction journal and receipt accounting. */
export function createObservationRuntime(options: {
  settings: Settings;
  chains: readonly ChainConfig[];
  path: string;
  assets?: (chain: ChainConfig) => readonly string[];
  client?: (chain: ChainConfig, signal: AbortSignal) => PublicClient;
}) {
  const abort = new AbortController();
  let store: ObservationStore | undefined;
  let observer: ReturnType<typeof startBalanceObserver> | undefined;
  let issue: string | null = null;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  if (options.settings.observations.enabled) {
    try {
      store = new ObservationStore(
        options.path,
        Date.now,
        options.settings.observations.maxRecords,
      );
      store.begin(options.settings.networkMode);
    } catch {
      try {
        store?.close();
      } catch {
        /* Observations must not prevent normal startup. */
      }
      store = undefined;
      issue =
        "Observation storage is unavailable; transaction accounting remains separate";
    }
  }
  return {
    store,
    start() {
      if (!store || observer || stopped) return;
      const client =
        options.client ??
        ((chain: ChainConfig, signal: AbortSignal) =>
          createPublicClient({
            cacheTime: 0,
            transport: http(rpcUrl(chain), {
              retryCount: 0,
              timeout: 5000,
              fetchOptions: { signal },
            }),
          }));
      observer = startBalanceObserver({
        chains: options.chains,
        settings: options.settings,
        store,
        client: (chain) => client(chain, abort.signal),
        intervalMs: options.settings.observations.balanceIntervalMs,
        ...(options.assets ? { assets: options.assets } : {}),
        signal: abort.signal,
      });
    },
    status() {
      return {
        enabled: options.settings.observations.enabled,
        available: !!store && !stopped,
        issue,
        balanceSampling: observer?.status() ?? null,
      };
    },
    stop(): Promise<void> {
      if (stopping) return stopping;
      stopped = true;
      abort.abort();
      stopping = (async () => {
        try {
          await observer?.stop();
        } finally {
          try {
            store?.close();
          } catch {
            issue =
              "Observation storage did not close cleanly; transaction accounting is separate";
          }
        }
      })();
      return stopping;
    },
  };
}
