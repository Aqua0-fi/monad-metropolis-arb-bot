import {
  runtimeScope,
  assertPendingScope,
  receiptReviewClients,
} from "./runtime-scope.js";
import { reviewEconomicWindow } from "./economic-review.js";
import { RuntimeControls } from "./runtime-controls.js";
import { runReactive } from "./reactive-runner.js";
import { loadRuntimeSecrets } from "./runtime-secrets.js";
import { readFileSync, statSync } from "node:fs";
import type { Server } from "node:http";
import { HistoryStore } from "./history.js";
import { SwapVMMarketCatalog } from "./swapvm-catalog.js";
import { MarketCatalog } from "./market-catalog.js";
import { createObservationRuntime } from "./observation-runtime.js";
import { createReportServer } from "./reporting.js";
import { parseArgs } from "node:util";
import { loadChains, loadSettings } from "./config.js";
import { AquaClient } from "./aqua.js";
import { BackendBudget } from "./backend-budget.js";
import { Runner, log, safeError } from "./runner.js";
import { Journal, acquireLock } from "./state.js";
import {
  clientFor,
  verifyChain,
  discover,
  type ExternalPool,
} from "./venues.js";
import { registryBlockers } from "./registry.js";
loadRuntimeSecrets(process.env.REBALANCER_RUNTIME_SECRETS_FILE);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: "config/rebalancer.example.json" },
    chain: { type: "string" },
    registry: { type: "string", default: "config/chains.json" },
    // The process stops itself after this many milliseconds (overrides settings.maxRuntimeMs).
    "max-runtime-ms": { type: "string" },
  },
});
const registeredChains = loadChains(values.registry);
const command = positionals[0] ?? "scan";
if (command === "doctor") {
  let failures = 0;
  const selected = registeredChains.filter(
    (c) => !values.chain || String(c.chainId) === values.chain,
  );
  if (selected.length === 0) throw new Error("Unknown chain selection");
  for (const chain of selected) {
    const blockers = registryBlockers(chain);
    if (blockers.length > 0) {
      failures++;
      log("chain_readiness", {
        chainId: chain.chainId,
        name: chain.name,
        status: "blocked",
        deploymentVerified: false,
        blockers,
        note: "Registered does not mean provisioned, funded or approved for execution",
      });
      continue;
    }
    let deploymentVerified = false;
    const markets: {
      poolId: string;
      externalPools: ExternalPool[];
      error?: string;
    }[] = [];
    try {
      const client = clientFor(chain);
      await verifyChain(client, chain);
      deploymentVerified = true;
      const block = await client.getBlock();
      for (const pool of chain.pools) {
        try {
          markets.push({
            poolId: pool.poolId,
            externalPools: await discover(client, chain, pool, block.number),
          });
        } catch (error) {
          markets.push({
            poolId: pool.poolId,
            externalPools: [],
            error: safeError(error),
          });
        }
      }
      const partial = markets.some((market) => market.error !== undefined);
      const hasLiquidity = markets.some(
        (market) => market.externalPools.length > 0,
      );
      if (partial || !hasLiquidity) failures++;
      log("chain_readiness", {
        chainId: chain.chainId,
        name: chain.name,
        status: partial
          ? "partial"
          : hasLiquidity
            ? "market_discovered"
            : "no_liquidity",
        deploymentVerified,
        block: block.number,
        blockHash: block.hash,
        markets,
        blockers: partial
          ? ["Some market discovery reads failed"]
          : hasLiquidity
            ? []
            : ["No liquid supported external pool found"],
        note: "Discovery does not verify executor funding, backend authorization or simulator parity",
      });
    } catch (error) {
      failures++;
      log("chain_readiness", {
        chainId: chain.chainId,
        name: chain.name,
        status: "unavailable",
        deploymentVerified,
        markets,
        blockers: [safeError(error)],
      });
    }
  }
  process.exitCode = failures ? 1 : 0;
} else {
  if (command !== "scan" && command !== "run")
    throw new Error("Use doctor, scan, or run");
  const { chains, settings } = runtimeScope(
    registeredChains,
    loadSettings(values.config),
    values.chain,
  );
  const headers: Record<string, string> = {
    "X-Network-Mode": settings.networkMode,
  };
  const readKey = process.env.AQUA0_READ_API_KEY ?? process.env.AQUA0_API_KEY;
  if (readKey) headers["X-API-Key"] = readKey;
  if (process.env.AQUA0_CALLER_TOKEN)
    headers["X-Caller-Token"] = process.env.AQUA0_CALLER_TOKEN;
  const release = acquireLock("runtime/worker.lock");
  let history: HistoryStore | undefined;
  let observations: ReturnType<typeof createObservationRuntime> | undefined;
  let catalog: MarketCatalog | undefined;
  let swapVMCatalog: SwapVMMarketCatalog | undefined;
  let server: Server | undefined;
  let controls: RuntimeControls | undefined;
  const shutdown = new AbortController();
  const stop = () => {
    shutdown.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const runtimeLimit = values["max-runtime-ms"]
    ? Number(values["max-runtime-ms"])
    : settings.maxRuntimeMs;
  if (
    runtimeLimit !== undefined &&
    (!Number.isSafeInteger(runtimeLimit) ||
      runtimeLimit < 10000 ||
      runtimeLimit > 86400000)
  )
    throw new Error("--max-runtime-ms must be between 10000 and 86400000");
  // A bounded run cannot outlive its budget: stop gracefully, then exit hard if shutdown stalls.
  const runtimeTimer =
    runtimeLimit === undefined
      ? undefined
      : setTimeout(() => {
          log("runtime_limit_reached", { runtimeLimitMs: runtimeLimit });
          stop();
          setTimeout(() => {
            log("runtime_limit_forced_exit", { runtimeLimitMs: runtimeLimit });
            process.exit(3);
          }, 30000).unref();
        }, runtimeLimit);
  const budget = new BackendBudget(
    {
      catalog: settings.backendBudget.catalog,
      search: settings.backendBudget.search,
      authorize: settings.backendBudget.authorize,
    },
    settings.backendBudget.file,
  );
  try {
    const journal = new Journal("runtime/journal.json");
    assertPendingScope(journal, chains, settings);
    history = new HistoryStore("runtime/history.sqlite");
    if (settings.discovery.enabled)
      catalog = new MarketCatalog(
        "runtime/markets.sqlite",
        settings.networkMode,
        chains,
        Date.now,
        settings.discovery.maxAgeMs,
      );
    if (settings.discovery.enabled)
      swapVMCatalog = new SwapVMMarketCatalog(
        "runtime/aqua-markets.sqlite",
        settings.networkMode,
        chains,
        Date.now,
        settings.discovery.maxAgeMs,
      );
    controls = new RuntimeControls(
      "runtime/controls.sqlite",
      settings.networkMode,
      chains.map((c) => c.chainId),
    );
    observations = createObservationRuntime({
      settings,
      chains,
      path: "runtime/observations.sqlite",
      assets: (chain) =>
        catalog
          ?.list()
          .markets.filter(
            (market) => market.chainId === chain.chainId && market.present,
          )
          .flatMap((market) => [
            market.pool.currency0,
            market.pool.currency1,
          ]) ?? [],
    });
    const runner = new Runner(
      chains,
      settings,
      new AquaClient(
        settings.apiUrl,
        headers,
        budget,
        process.env.AQUA0_OPERATOR_API_KEY || undefined,
      ),
      journal,
      history,
      catalog,
      swapVMCatalog,
      controls,
      observations.store,
    );
    if (command === "run") {
      const reviewClient = receiptReviewClients(registeredChains, clientFor);
      server = createReportServer({
        network: settings.networkMode,
        token: process.env.REBALANCER_REPORT_TOKEN,
        controlToken: process.env.REBALANCER_CONTROL_TOKEN,
        catalog,
        swapVMCatalog,
        controls,
        onPolicyChanged: (id) => runner.marketChanged(id),
        economicReview: (input, actor) =>
          reviewEconomicWindow(
            history!,
            settings.networkMode,
            input,
            actor,
            reviewClient,
          ),
        hostHealth: () => {
          const path = process.env.REBALANCER_HOST_HEALTH_FILE;
          if (!path)
            return {
              available: false,
              reason: "Host watchdog is not configured",
            };
          try {
            if (statSync(path).size > 131072)
              throw new Error("Oversized host-health report");
            return JSON.parse(readFileSync(path, "utf8")) as unknown;
          } catch {
            return {
              available: false,
              reason: "Host watchdog report is unavailable",
            };
          }
        },
        history,
        observations: observations.store,
        status: () => {
          const status = runner.reportingStatus();
          return {
            ...status,
            backendBudget: runner.backendBudget(),
            observationHistory: {
              ...observations!.status(),
              writerIssue: status.observationHistory.issue,
            },
          };
        },
        health: () => ({
          healthy:
            Date.now() - runner.metrics.lastHeartbeat <
            Math.max(120000, settings.pollMs * 4),
          metrics: runner.metrics,
        }),
      });
      const port = Number(process.env.REBALANCER_REPORT_PORT ?? "9091");
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("Invalid reporting port");
      const host = process.env.REBALANCER_REPORT_HOST ?? "127.0.0.1";
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(port, host, resolve);
      });
      observations.start();
    }
    if (command === "scan") await runner.scan();
    else await runReactive(runner, chains, settings, shutdown.signal);
  } finally {
    if (runtimeTimer) clearTimeout(runtimeTimer);
    log("backend_budget_summary", { backendBudget: budget.status() });
    if (server?.listening)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await observations?.stop();
    history?.close();
    catalog?.close();
    swapVMCatalog?.close();
    controls?.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    release();
  }
}
