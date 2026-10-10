import type { ChainConfig, Settings } from "./config.js";
import { startHeadFeed } from "./head-feed.js";
import { LatestHeadScheduler, type ObservedHead } from "./head-scheduler.js";
import { type Runner, log, safeError } from "./runner.js";

/** Block work and slow catalogue refresh are separate lifetimes. No all-chain sleep-after-scan. */
export async function runReactive(
  runner: Runner,
  chains: ChainConfig[],
  settings: Settings,
  signal: AbortSignal,
): Promise<void> {
  const config = settings.scheduling;
  const feeds = new Map<number, ReturnType<typeof startHeadFeed>>();
  const heads = new Map<number, ObservedHead>();
  const scheduler = new LatestHeadScheduler({
    maxConcurrent: config.maxConcurrentChains,
    maxBlockLag: config.maxScanBlockLag,
    maxTaskMs: config.maxScanMs,
    run: (chain, task) => runner.scanLatest(chain, task),
    onError: (chain, error) =>
      log("reactive_scan_error", { chainId: chain, error: safeError(error) }),
  });
  let ended = false,
    discoveryRunning: Promise<void> | undefined;
  runner.schedulingStatus = () => ({
    mode: "block-driven",
    headerPollMs: config.headerPollMs,
    chains: scheduler.status(),
    feeds: [...feeds].map(([chainId, f]) => ({ chainId, ...f.status() })),
  });
  const sync = () => {
    if (ended) return;
    runner.metrics.lastHeartbeat = Date.now();
    const wanted = new Set(runner.activeChainIds());
    for (const [id, feed] of feeds) {
      if (!wanted.has(id)) {
        feeds.delete(id);
        heads.delete(id);
        void feed.stop();
      }
    }
    for (const id of wanted) {
      if (feeds.has(id)) continue;
      const chain = chains.find((c) => c.chainId === id);
      if (!chain) continue;
      const env = config.websocketEnv[String(id)],
        url = env ? process.env[env] : undefined;
      if (env && !url)
        log("head_subscription_missing", {
          chainId: id,
          reason:
            "Configured WebSocket environment variable is absent; using HTTP header checks",
        });
      feeds.set(
        id,
        startHeadFeed({
          chainId: id,
          client: runner.client(id),
          ...(url ? { websocketUrl: url } : {}),
          pollMs: config.headerPollMs,
          auditMs: config.websocketAuditMs,
          onHead: (h) => {
            heads.set(id, h);
            scheduler.notify(id, h);
          },
          onError: (e) =>
            log("head_source_error", { chainId: id, error: safeError(e) }),
        }),
      );
    }
  };
  runner.marketChanged = (id) => {
    sync();
    if (id === 0) {
      for (const [chain, h] of heads) scheduler.notify(chain, h, true);
    } else {
      const h = heads.get(id);
      if (h) scheduler.notify(id, h, true);
    }
  };
  const discover = () => {
    if (ended || discoveryRunning || !settings.discovery.enabled) return;
    discoveryRunning = (async () => {
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(2, chains.length) }, async () => {
          while (!ended) {
            const chain = chains[next++];
            if (!chain) break;
            await runner.discoverChain(chain.chainId);
            sync();
          }
        }),
      );
    })()
      .catch((e) => log("discovery_error", { error: safeError(e) }))
      .finally(() => {
        discoveryRunning = undefined;
      });
  };
  const syncTimer = setInterval(sync, 1000),
    discoveryTimer = setInterval(discover, settings.discovery.intervalMs);
  sync();
  discover();
  try {
    if (!signal.aborted)
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
  } finally {
    ended = true;
    clearInterval(syncTimer);
    clearInterval(discoveryTimer);
    runner.marketChanged = () => {};
    await Promise.all([
      scheduler.stop(),
      ...Array.from(feeds.values(), (f) => f.stop()),
      discoveryRunning,
    ]);
  }
}
