import { verifyV4Quote } from "./v4-quote-state.js";
import { ObservationStore, type OpportunityUpdate } from "./observations.js";
import { StaleCandidateError } from "./freshness.js";
import { safeError } from "./diagnostics.js";
import { FeeProfitRefusal } from "./live-fees.js";
import { assertEconomicExecution } from "./economic-gate.js";
import type { RuntimeControls } from "./runtime-controls.js";
import {
  ReadyOpportunityQueue,
  forEachConcurrent,
} from "./opportunity-queue.js";
import { ObsoleteScan, type ScanTask } from "./head-scheduler.js";
import { registryBlockers } from "./registry.js";
import { erc20Abi, type Address, type PublicClient } from "viem";
import { executorAbi } from "./abi.js";
import { AquaClient, AquaCapacityLimit } from "./aqua.js";
import {
  clientFor,
  discoverCached,
  quoteV3,
  verifyChain,
  type ExternalPool,
} from "./venues.js";
import { V4Screen, type ScreenResult } from "./v4-screen.js";
import { BackendBudgetExceeded } from "./backend-budget.js";
import { findPool, same, type ChainConfig, type Settings } from "./config.js";
import { ceilDiv, findCandidates, type Candidate } from "./strategy.js";
import { submit } from "./execution.js";
import { reconcile } from "./reconciliation.js";
import { Journal } from "./state.js";
import type { HistoryStore } from "./history.js";
import type { MarketCatalog } from "./market-catalog.js";
import type { SwapVMMarketCatalog } from "./swapvm-catalog.js";
import {
  collectSwapVMChoices,
  refreshSwapVMChoice,
  type SwapVMChoice,
} from "./swapvm-search.js";
export const json = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
export const log = (
  event: string,
  data: Record<string, unknown> = {},
): void => {
  console.log(json({ time: new Date().toISOString(), event, ...data }));
};
export { safeError } from "./diagnostics.js";

type ReadyChoice =
  | {
      kind: "v4";
      startToken: Address;
      candidate: Candidate;
      market: Settings["markets"][number];
      pool: ReturnType<typeof findPool>;
      external: ExternalPool;
    }
  | SwapVMChoice;
const compareReady = (a: ReadyChoice, b: ReadyChoice) => {
  if (same(a.startToken, b.startToken))
    return a.candidate.netProfit > b.candidate.netProfit
      ? -1
      : a.candidate.netProfit < b.candidate.netProfit
        ? 1
        : 0;
  const left = a.candidate.netProfit * b.candidate.trade.first.amountIn,
    right = b.candidate.netProfit * a.candidate.trade.first.amountIn;
  return left > right ? -1 : left < right ? 1 : 0;
};
export class Runner {
  private clients = new Map<number, PublicClient>();
  private verified = new Set<number>();
  readonly metrics = {
    scans: 0,
    candidates: 0,
    submitted: 0,
    errors: 0,
    lastSuccess: 0,
    lastHeartbeat: Date.now(),
    scanStartedAt: 0,
    scanDurationMs: 0,
  };
  private errors = new Map<number, number>();
  private lastScans = new Map<number, { at: string; error: string | null }>();
  private readonly startedAt = new Date().toISOString();
  private retryAt = new Map<number, number>();
  private activity: {
    id: number;
    at: string;
    chainId: number;
    event: string;
    venue: string | null;
    reason: string | null;
    amount: string | null;
  }[] = [];
  private activitySequence = 0;
  private observationIssue: string | null = null;
  private observe(action: (store: ObservationStore) => void) {
    if (!this.observations) return;
    try {
      action(this.observations);
      this.observationIssue = null;
    } catch {
      this.observationIssue =
        "Observation history could not be persisted; transaction accounting remains separate";
    }
  }
  private updateObservation(choice: ReadyChoice, change: OpportunityUpdate) {
    this.observe((store) =>
      store.update(
        this.settings.networkMode,
        choice.market.chainId,
        choice.candidate.trade.id,
        change,
      ),
    );
  }
  private executionProgress(
    choice: ReadyChoice,
    candidate: Candidate,
    chainId: number,
    stage: string,
    details?: Record<string, unknown>,
  ) {
    if (
      stage === "fee_estimated" &&
      details?.tokenCost !== undefined &&
      details.estimatedNetProfit !== undefined
    )
      this.updateObservation(choice, {
        estimatedFee: String(details.tokenCost),
        estimatedNet: String(details.estimatedNetProfit),
        executionAmountIn: String(candidate.trade.first.amountIn),
        executionTradeId: candidate.trade.id,
      });
    if (
      stage === "broadcasting" &&
      typeof details?.transactionHash === "string"
    )
      this.updateObservation(choice, {
        state: "transaction-prepared",
        transactionHash: details.transactionHash,
        executionTradeId: candidate.trade.id,
        executionAmountIn: String(candidate.trade.first.amountIn),
        reason:
          "Transaction persisted before broadcast; confirm its result in trade history",
      });
    this.event(stage, { chainId, ...details });
  }

  private stages = new Map<number, { stage: string; since: string }>();
  private event(event: string, data: Record<string, unknown> = {}) {
    log(event, data);
    if (typeof data.chainId !== "number") return;
    const stage: Record<string, string> = {
      scan_started: "Checking prices",
      no_eligible_markets: "Waiting for an eligible approved market",
      opportunity_ready: "Opportunity found",
      opportunity: "Rechecking selected trade",
      signing: "Signing transaction",
      simulating: "Simulating both trades",
      fee_estimated: "Actual transaction fees checked",
      fee_unprofitable: "No trade: fees exceed margin",
      broadcasting: "Sending transaction",
      submitted: "Waiting for receipt",
      pending_transaction: "Waiting for receipt",
      reconciliation_blocked: "Receipt recording needs attention",
      operator_paused: "Paused by operator",
      economic_paused: "Paused for economic review",
      chain_error: "Needs attention",
      obsolete_scan_discarded: "Refreshing changed state",
      scan_complete: "Waiting for a new block",
      jit_authorization: "Checking shared liquidity and permission",
    };
    const label =
      event === "scan_complete" && data.submitted
        ? "Waiting for receipt"
        : stage[event];
    if (label)
      this.stages.set(data.chainId, {
        stage: label,
        since: new Date().toISOString(),
      });
    const noteworthy = new Set([
      "opportunity_ready",
      "opportunity",
      "submitted",
      "reconciliation_blocked",
      "no_eligible_markets",
      "operator_paused",
      "economic_paused",
      "chain_error",
      "obsolete_scan_discarded",
      "sizing_rejected",
      "swapvm_sizing_rejected",
      "opportunity_disappeared",
    ]);
    if (!noteworthy.has(event)) return;
    const previous = this.activity[this.activity.length - 1];
    if (
      previous?.chainId === data.chainId &&
      previous.event === event &&
      Date.now() - Date.parse(previous.at) < 3000
    )
      return;
    this.activity.push({
      id: ++this.activitySequence,
      at: new Date().toISOString(),
      chainId: data.chainId,
      event,
      venue: typeof data.venue === "string" ? data.venue.slice(0, 40) : null,
      reason:
        typeof data.error === "string"
          ? safeError(new Error(data.error))
          : typeof data.reason === "string"
            ? safeError(new Error(data.reason))
            : null,
      amount: typeof data.amount === "bigint" ? data.amount.toString() : null,
    });
    if (this.activity.length > 60) this.activity.shift();
  }

  private busy = new Set<number>();
  schedulingStatus: () => unknown = () => ({ mode: "one-shot" });
  marketChanged: (chainId: number) => void = () => {};
  client(chainId: number): PublicClient {
    let client = this.clients.get(chainId);
    if (!client) {
      const chain = this.chains.find((c) => c.chainId === chainId);
      if (!chain) throw new Error("Unknown chain");
      client = clientFor(chain);
      this.clients.set(chainId, client);
    }
    return client;
  }
  activeChainIds(): number[] {
    return [
      ...new Set([
        ...this.markets().map((m) => m.chainId),
        ...this.swapVMMarkets().map((m) => m.market.chainId),
        ...Object.keys(this.settings.execution).map(Number),
      ]),
    ];
  }
  async discoverChain(chainId: number): Promise<void> {
    if (!this.settings.discovery.enabled) return;
    const chain = this.chains.find((c) => c.chainId === chainId);
    if (!chain) return;
    await Promise.all([
      (async () => {
        try {
          this.catalog!.recordListing(chain, await this.aqua.listPools(chain));
        } catch (e) {
          this.catalog!.recordFailure(chainId, safeError(e));
        }
      })(),
      (async () => {
        if (!this.swapVMCatalog) return;
        try {
          this.swapVMCatalog.recordListing(
            chain,
            await this.aqua.listSwapVM(chain),
          );
        } catch {
          this.swapVMCatalog.recordFailure(chainId);
        }
      })(),
    ]);
    this.metrics.lastHeartbeat = Date.now();
    this.marketChanged(chainId);
  }

  constructor(
    private readonly chains: ChainConfig[],
    private readonly settings: Settings,
    private readonly aqua: AquaClient,
    private readonly journal: Journal,
    private readonly history?: HistoryStore,
    private readonly catalog?: MarketCatalog,
    private readonly swapVMCatalog?: SwapVMMarketCatalog,
    private readonly controls?: RuntimeControls,
    private readonly observations?: ObservationStore,
  ) {
    if (settings.discovery.enabled && !catalog)
      throw new Error("Discovery needs a persistent market catalog");
    this.screen = new V4Screen(settings.v4Search, settings.slippageBps);
  }
  private readonly screen: V4Screen;
  backendBudget() {
    return this.aqua.budget.status();
  }
  /** Execute mode trades only inside the executor's owner-opened window; outside it no backend call is made. */
  private async executorWindow(
    client: PublicClient,
    executor: Address,
  ): Promise<{ open: boolean; reason?: string }> {
    const head = await client.getBlock();
    const paused = await client.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "paused",
      blockNumber: head.number,
    });
    if (paused) return { open: false, reason: "Executor is paused" };
    let activeUntil: bigint;
    try {
      activeUntil = await client.readContract({
        address: executor,
        abi: executorAbi,
        functionName: "activeUntil",
        blockNumber: head.number,
      });
    } catch {
      // Executors deployed before the trading window existed have no such getter.
      return { open: true };
    }
    if (activeUntil < head.timestamp)
      return { open: false, reason: "Executor trading window is closed" };
    return { open: true };
  }
  /**
   * Screened V4 search: free screen first, then one read-tier backend quote for the single size and
   * route order the screen selected. `fixed` re-prices a selected trade before authorization.
   */
  private async quoteGrid(p: {
    client: PublicClient;
    chain: ChainConfig;
    pool: ReturnType<typeof findPool>;
    market: Settings["markets"][number];
    external: ExternalPool;
    inputCap: bigint;
    head: { number: bigint; hash: `0x${string}`; timestamp: bigint };
    fixed?: { amount: bigint; aquaFirst: boolean };
    /** A free screen this scan already ran for `external`, so it is not screened twice. */
    screened?: ScreenResult | undefined;
  }): Promise<Candidate[]> {
    const { client, chain, pool, market, external, head } = p;
    let amount: bigint, aquaFirst: boolean, fingerprint: string | undefined;
    const key = V4Screen.key(chain.chainId, pool, external);
    if (p.fixed) {
      ({ amount, aquaFirst } = p.fixed);
    } else {
      const screen = p.screened ?? (await this.screenExternal(p));
      if (!screen.go) return [];
      ({ amount, aquaFirst, fingerprint } = screen);
    }
    const counterpart = (input: Address) =>
      same(input, pool.currency0) ? pool.currency1 : pool.currency0;
    let capped = false;
    const candidates = await findCandidates({
      base: market.baseToken,
      other: counterpart(market.baseToken),
      pool,
      router: chain.universalRouter,
      external: external.address,
      amounts: [amount],
      directions: [aquaFirst],
      slippageBps: this.settings.slippageBps,
      minNetProfit: market.minNetProfit,
      // Not a zero-fee assertion: the exact call cost is measured before signing.
      gasCost: 0n,
      blockNumber: head.number,
      timestamp: head.timestamp,
      quoteAqua: (input, value) =>
        this.aqua.quote(chain, pool, market, input, value),
      quoteExternal: (input, value) =>
        quoteV3(
          client,
          external.venue.quoter,
          external.fee,
          input,
          counterpart(input),
          value,
          head.number,
        ),
      onQuoteError: (error) => {
        if (error instanceof BackendBudgetExceeded) throw error;
        if (error instanceof AquaCapacityLimit) {
          capped = true;
          this.screen.noteCapacity(key, aquaFirst, error.backed);
        }
        this.event("v4_quote_rejected", {
          chainId: chain.chainId,
          poolId: pool.poolId,
          error: safeError(error),
        });
      },
    });
    // A capacity refusal is not "no profitable fill": the next screen retries at the backed size.
    if (fingerprint && !capped)
      this.screen.noteBackend(key, fingerprint, candidates.length > 0);
    for (const candidate of candidates) candidate.quoteBlockHash = head.hash;
    return candidates;
  }
  /** The free screen of one external pool against the Aqua0 pool: RPC reads only, no backend call. */
  private async screenExternal(p: {
    client: PublicClient;
    chain: ChainConfig;
    pool: ReturnType<typeof findPool>;
    market: Settings["markets"][number];
    external: ExternalPool;
    inputCap: bigint;
    head: { number: bigint };
  }): Promise<ScreenResult> {
    const screen = await this.screen.screen({
      client: p.client,
      chain: p.chain,
      pool: p.pool,
      market: p.market,
      external: p.external,
      inputCap: p.inputCap,
      blockNumber: p.head.number,
    });
    this.event("v4_screen", {
      chainId: p.chain.chainId,
      poolId: p.pool.poolId,
      externalPool: p.external.address,
      go: screen.go,
      reason: screen.reason,
      expectedProfit: screen.expectedProfit ?? null,
      required: screen.required ?? null,
    });
    return screen;
  }
  private swapVMMarkets() {
    return (
      this.swapVMCatalog
        ?.list()
        .markets.filter(
          (m) =>
            m.readyToQuote &&
            this.chains.some((c) => c.chainId === m.market.chainId),
        ) ?? []
    );
  }
  private markets() {
    const markets = this.settings.discovery.enabled
      ? this.catalog!.activeMarkets()
      : this.settings.markets;
    return markets.filter((m) =>
      this.chains.some((c) => c.chainId === m.chainId),
    );
  }
  private assertMarketApproval(market: Settings["markets"][number]) {
    if (!this.settings.discovery.enabled) return;
    const current = this.catalog!.activeMarkets().find(
      (m) => m.chainId === market.chainId && same(m.poolId, market.poolId),
    );
    if (
      !current ||
      current.classId !== market.classId ||
      !same(current.baseToken, market.baseToken) ||
      current.maxInput !== market.maxInput ||
      current.minNetProfit !== market.minNetProfit ||
      current.amounts.join(",") !== market.amounts.join(",")
    )
      throw new Error(
        "Market approval changed or discovery became stale; refresh before authorizing or broadcasting",
      );
  }
  reportingStatus() {
    return {
      version: 1 as const,
      service: "market-rebalancer-service",
      network: this.settings.networkMode,
      mode: this.settings.mode,
      generatedAt: new Date().toISOString(),
      startedAt: this.startedAt,
      metrics: { ...this.metrics },
      scheduling: this.schedulingStatus(),
      operatingControl: this.controls?.read() ?? null,
      economics: this.history?.economics(this.settings.networkMode) ?? null,
      recentActivity: [...this.activity].reverse(),
      searchQueue: this.aqua.searchStatus(),
      observationHistory: {
        available: !!this.observations,
        issue: this.observationIssue,
      },
      chains: this.chains.map((chain) => ({
        chainId: chain.chainId,
        name: chain.name,
        nativeCurrency: chain.nativeCurrency ?? null,
        configuredMarkets:
          this.markets().filter((m) => m.chainId === chain.chainId).length +
          this.swapVMMarkets().filter((m) => m.market.chainId === chain.chainId)
            .length,
        quoteConfigured: !!(
          this.settings.execution[String(chain.chainId)] ??
          this.settings.quoteFees[String(chain.chainId)]
        ),
        registryBlockers: registryBlockers(chain),
        deploymentVerified: this.verified.has(chain.chainId),
        executionEnabled:
          this.settings.mode === "execute" &&
          !!this.settings.execution[String(chain.chainId)]?.allowBroadcast,
        circuitOpen:
          (this.errors.get(chain.chainId) ?? 0) >=
          this.settings.maxConsecutiveErrors,
        lastScan: this.lastScans.get(chain.chainId) ?? null,
        activity: this.stages.get(chain.chainId) ?? null,
        retryAt: this.retryAt.get(chain.chainId) ?? null,
        pools: chain.pools.map((pool) => ({
          poolId: pool.poolId,
          currency0: pool.currency0,
          currency1: pool.currency1,
        })),
      })),
    };
  }
  async scan(): Promise<void> {
    if (this.settings.discovery.enabled)
      await Promise.all(this.chains.map((c) => this.discoverChain(c.chainId)));
    await Promise.all(this.activeChainIds().map((id) => this.scanLatest(id)));
  }
  async scanLatest(chainId: number, task?: ScanTask): Promise<void | false> {
    if (this.busy.has(chainId))
      throw new Error(
        "A scan already owns this chain; do not overlap its nonce lane",
      );
    if (Date.now() < (this.retryAt.get(chainId) ?? 0)) return false;
    this.busy.add(chainId);
    const started = Date.now();
    this.metrics.scanStartedAt = started;
    this.event("scan_started", { chainId });
    try {
      task?.assertActive();
      const outcome = await this.scanChain(chainId, task);
      if (outcome === "skipped") return false;
      this.errors.set(chainId, 0);
      this.retryAt.delete(chainId);
      this.metrics.lastSuccess = Date.now();
      this.lastScans.set(chainId, {
        at: new Date().toISOString(),
        error: null,
      });
    } catch (error) {
      if (
        error instanceof ObsoleteScan ||
        error instanceof StaleCandidateError ||
        task?.signal.aborted
      ) {
        this.event("obsolete_scan_discarded", {
          chainId,
          reason: safeError(task?.signal.aborted ? task.signal.reason : error),
        });
        throw new ObsoleteScan();
      }
      const count = (this.errors.get(chainId) ?? 0) + 1;
      this.errors.set(chainId, count);
      this.metrics.errors++;
      this.retryAt.set(
        chainId,
        Date.now() + Math.min(60000, 250 * 2 ** Math.min(count, 8)),
      );
      this.lastScans.set(chainId, {
        at: new Date().toISOString(),
        error: safeError(error),
      });
      this.event("chain_error", { chainId, error: safeError(error) });
      throw error;
    } finally {
      this.busy.delete(chainId);
      this.metrics.scans++;
      this.metrics.lastHeartbeat = Date.now();
      this.metrics.scanDurationMs = Date.now() - started;
    }
  }
  private async scanChain(
    chainId: number,
    task?: ScanTask,
  ): Promise<void | "skipped"> {
    const check = () => {
      task?.assertActive();
      if (this.controls?.paused(chainId))
        throw new ObsoleteScan("New checks and trades are paused");
    };
    task?.assertActive();
    const configured = this.chains.find((c) => c.chainId === chainId);
    if (!configured) throw new Error("Unknown configured chain");
    const chain = this.settings.discovery.enabled
      ? { ...configured, pools: this.catalog!.activePools(chainId) }
      : configured;
    const client = this.client(chainId);
    if (!this.verified.has(chainId)) {
      await verifyChain(client, chain);
      this.verified.add(chainId);
    }
    const execution = this.settings.execution[String(chainId)];
    // Reconcile pending transactions even when a policy or quote profile changed.
    let reconciliationIssue = false;
    if (
      !(await reconcile(
        client,
        chain,
        this.settings,
        this.journal,
        this.history,
        {
          onIssue: (issue) => {
            reconciliationIssue = true;
            this.event("reconciliation_blocked", {
              chainId,
              reason: `${issue.stage}: ${issue.reason}`,
              hash: issue.hash,
            });
          },
        },
      ))
    ) {
      if (!reconciliationIssue) this.event("pending_transaction", { chainId });
      return;
    }
    if (
      execution &&
      this.journal.get(`${chainId}:${execution.operator.toLowerCase()}`)
        .errors >= this.settings.maxConsecutiveErrors
    ) {
      throw new Error("Receipt failure circuit is open");
    }
    if (this.controls?.paused(chainId)) {
      this.event("operator_paused", { chainId });
      return;
    }
    if (this.history?.economics(this.settings.networkMode).blocked) {
      this.event("economic_paused", {
        chainId,
        reason: this.history.economics(this.settings.networkMode).reason,
      });
      return;
    }
    if (this.settings.mode === "execute")
      assertEconomicExecution(this.history, this.settings.networkMode);
    check();
    if (
      !this.markets().some((m) => m.chainId === chainId) &&
      !this.swapVMMarkets().some((m) => m.market.chainId === chainId)
    ) {
      this.event("no_eligible_markets", {
        chainId,
        reason:
          "No approved market currently has a verified quoteable discovery record. Check the market catalog for the refusal reason.",
      });
      return "skipped";
    }
    const config = execution ?? this.settings.quoteFees[String(chainId)];
    if (!config)
      throw new Error(
        "Configure a read-only chain fee budget before economic scans",
      );
    if (this.settings.mode === "execute" && !execution)
      throw new Error("No funded execution configuration");
    const v4Markets = this.markets().filter((m) => m.chainId === chainId);
    if (v4Markets.length) {
      const blockers = registryBlockers(chain);
      if (blockers.length > 0)
        throw new Error(`Chain not ready: ${blockers.join("; ")}`);
    }
    const choices: ReadyChoice[] = [];
    const queuedAt = new WeakMap<ReadyChoice, string>();
    const searchStop = new AbortController();
    const searchSignal = task
      ? AbortSignal.any([task.signal, searchStop.signal])
      : searchStop.signal;
    const executionQueue =
      this.settings.mode === "execute"
        ? new ReadyOpportunityQueue<ReadyChoice>(
            compareReady,
            (choice) => this.executeChoice(chain, client, choice, task),
            () =>
              searchStop.abort(
                new Error("Execution lane has selected a trade"),
              ),
            (choice) => !task || queuedAt.get(choice) === task.queueRevision(),
          )
        : undefined;
    const offer = (choice: ReadyChoice) => {
      if (searchSignal.aborted) return;
      if (task) {
        if (!choice.candidate.quoteBlockHash) return;
        task.adoptQuote(
          choice.candidate.blockNumber,
          choice.candidate.quoteBlockHash,
        );
        queuedAt.set(choice, task.queueRevision());
      }
      check();
      choices.push(choice);
      this.observe((store) =>
        store.found({
          id: choice.candidate.trade.id,
          network: this.settings.networkMode,
          chainId,
          venue: choice.kind,
          marketId:
            choice.kind === "aqua"
              ? choice.market.stableStrategyId
              : choice.pool.poolId,
          classId: String(choice.market.classId),
          caller:
            execution?.executor ??
            this.settings.quoteFees[String(chainId)]?.caller ??
            null,
          baseToken: choice.startToken,
          otherToken: choice.candidate.trade.first.tokenOut,
          externalPool: choice.external.address,
          aquaFirst: choice.candidate.aquaFirst,
          amountIn: String(choice.candidate.trade.first.amountIn),
          executionAmountIn: null,
          quotedGross: String(choice.candidate.quotedProfit),
          conservativeGross: String(
            choice.candidate.trade.second.minOut -
              choice.candidate.trade.first.amountIn,
          ),
          estimatedFee: choice.candidate.feeEstimate
            ? String(choice.candidate.feeEstimate.tokenCost)
            : null,
          estimatedNet: choice.candidate.feeEstimate
            ? String(choice.candidate.netProfit)
            : null,
          quoteBlock: String(choice.candidate.blockNumber),
          quoteBlockHash: choice.candidate.quoteBlockHash,
          foundAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          quoteObservedAt: new Date(choice.candidate.quotedAt).toISOString(),
          state: "found",
          reason: null,
          transactionHash: null,
          executionTradeId: null,
        }),
      );
      this.metrics.candidates++;
      executionQueue?.offer(choice);
      this.event("opportunity_ready", {
        chainId,
        venue: choice.kind,
        baseToken: choice.startToken,
        amount: choice.candidate.trade.first.amountIn,
        conservativeNetProfit: choice.candidate.feeEstimate
          ? choice.candidate.netProfit
          : null,
        grossProfitBeforeGas: choice.candidate.quotedProfit,
        feeStatus: choice.candidate.feeEstimate ? "estimated" : "unverified",
        selection: "best-currently-ready; does not wait for slower venues",
      });
    };
    let quoteFailures = 0,
      completedQuotes = 0;
    const v4Window =
      this.settings.mode === "execute" && v4Markets.length && execution
        ? await this.executorWindow(client, execution.executor)
        : { open: true };
    const allowedExternal =
      execution?.externalPools ??
      this.settings.v4Search.externalPools[String(chainId)];
    const collectV4 = () =>
      forEachConcurrent(
        v4Markets,
        2,
        async (market) => {
          if (searchSignal.aborted) return;
          check();
          const pool = findPool(chain, market);
          if (!v4Window.open) {
            this.event("executor_inactive", {
              chainId,
              poolId: pool.poolId,
              reason: v4Window.reason,
            });
            return;
          }
          const head = await client.getBlock();
          let inputCap =
            market.maxInput < (1n << 128n) - 1n
              ? market.maxInput
              : (1n << 128n) - 1n;
          if (this.settings.mode === "execute") {
            const [inventory, limits] = await Promise.all([
              client.readContract({
                address: market.baseToken,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [execution!.executor],
                blockNumber: head.number,
              }),
              client.readContract({
                address: execution!.executor,
                abi: executorAbi,
                functionName: "limits",
                args: [market.baseToken],
                blockNumber: head.number,
              }),
            ]);
            if (inventory < inputCap) inputCap = inventory;
            if (limits[0] < inputCap) inputCap = limits[0];
          }
          if (inputCap === 0n) {
            this.event("no_operating_inventory", {
              chainId,
              poolId: pool.poolId,
            });
            return;
          }
          const venues = (
            await discoverCached(client, chain, pool, head.number)
          ).filter(
            (venue) =>
              !allowedExternal ||
              allowedExternal.some((allowed) => same(allowed, venue.address)),
          );
          // quote-grid screens every external pool for free and sends only the widest gap to the backend.
          // Quoting each one spent the per-minute search budget on the same Aqua0-side quote, leaving none
          // for the re-quote before authorization, so no trade could ever execute.
          const screened = new Map<string, ScreenResult>();
          let searched = venues;
          if (this.settings.v4Search.mode === "quote-grid") {
            await forEachConcurrent(
              venues,
              2,
              async (external) => {
                if (searchSignal.aborted) return;
                check();
                try {
                  screened.set(
                    external.address.toLowerCase(),
                    await this.screenExternal({
                      client,
                      chain,
                      pool,
                      market,
                      external,
                      inputCap,
                      head,
                    }),
                  );
                } catch (error) {
                  if (searchSignal.aborted) return;
                  if (
                    error instanceof StaleCandidateError ||
                    error instanceof ObsoleteScan
                  )
                    throw error;
                  this.event("sizing_rejected", {
                    chainId,
                    poolId: pool.poolId,
                    venue: external.venue.name,
                    error: safeError(error),
                  });
                  quoteFailures++;
                }
              },
              searchSignal,
            );
            let best: { external: ExternalPool; profit: bigint } | undefined;
            for (const external of venues) {
              const screen = screened.get(external.address.toLowerCase());
              if (screen?.go && (!best || screen.expectedProfit > best.profit))
                best = { external, profit: screen.expectedProfit };
            }
            searched = best ? [best.external] : [];
          }
          await forEachConcurrent(
            searched,
            2,
            async (external) => {
              if (searchSignal.aborted) return;
              check();
              try {
                this.assertMarketApproval(market);
                if (this.settings.v4Search.mode === "quote-grid") {
                  const found = await this.quoteGrid({
                    client,
                    chain,
                    pool,
                    market,
                    external,
                    inputCap,
                    head,
                    screened: screened.get(external.address.toLowerCase()),
                  });
                  completedQuotes += found.length;
                  for (const candidate of found) {
                    await verifyV4Quote(client, candidate, this.settings, {
                      signal: searchSignal,
                      check,
                    });
                    this.assertMarketApproval(market);
                    offer({
                      kind: "v4",
                      startToken: market.baseToken,
                      candidate,
                      market,
                      pool,
                      external,
                    });
                  }
                  return;
                }
                const optimized = await this.aqua.optimize({
                  chain,
                  pool,
                  market,
                  external,
                  network: this.settings.networkMode,
                  maxInput: inputCap,
                  // Not a zero-fee assertion: exact cost is measured only for the full chosen call.
                  gasBudget: 0n,
                  slippageBps: this.settings.slippageBps,
                  signal: searchSignal,
                });
                if (searchSignal.aborted) return;
                check();
                completedQuotes += optimized.searches.reduce(
                  (sum, item) => sum + item.curveEvaluations,
                  0,
                );
                this.event("automatic_sizing", {
                  chainId,
                  poolId: pool.poolId,
                  externalPool: external.address,
                  inputCap,
                  blockNumber: optimized.blockNumber,
                  searches: optimized.searches,
                  excluded: optimized.excluded.map((item) => ({
                    aquaFirst: item.aquaFirst,
                    reason: safeError(new Error(item.reason)),
                  })),
                });
                for (const candidate of optimized.candidates) {
                  await verifyV4Quote(client, candidate, this.settings, {
                    signal: searchSignal,
                    check,
                  });
                  this.assertMarketApproval(market);
                  offer({
                    kind: "v4",
                    startToken: market.baseToken,
                    candidate,
                    market,
                    pool,
                    external,
                  });
                }
              } catch (error) {
                if (searchSignal.aborted) return;
                if (error instanceof BackendBudgetExceeded) {
                  this.event("backend_budget_exhausted", {
                    chainId,
                    poolId: pool.poolId,
                    reason: error.message,
                  });
                  return;
                }
                this.event("sizing_rejected", {
                  chainId,
                  poolId: pool.poolId,
                  venue: external.venue.name,
                  error: safeError(error),
                });
                // Preserve transient expiry/reorg classification through the
                // drained read batch instead of escalating it into a minute-long
                // chain-failure backoff. Actual RPC/quote failures still count.
                if (
                  error instanceof StaleCandidateError ||
                  error instanceof ObsoleteScan
                )
                  throw error;
                quoteFailures++;
              }
            },
            searchSignal,
          );
        },
        searchSignal,
      );
    const vmContext = this.swapVMCatalog
      ? {
          client,
          chain,
          settings: this.settings,
          aqua: this.aqua,
          catalog: this.swapVMCatalog,
          onEvent: (event: string, data: Record<string, unknown>) => {
            if (event === "swapvm_sizing_rejected") quoteFailures++;
            if (
              event === "swapvm_automatic_sizing" &&
              Array.isArray(data.searches)
            ) {
              completedQuotes += data.searches.reduce(
                (sum, search) =>
                  sum +
                  (Number.isSafeInteger(search.evaluatedInputs)
                    ? search.evaluatedInputs
                    : 0),
                0,
              );
            }
            this.event(event, data);
          },
          check,
          signal: searchSignal,
          onCandidate: offer,
        }
      : undefined;
    const reads = await Promise.allSettled([
      collectV4(),
      vmContext ? collectSwapVMChoices(vmContext) : Promise.resolve([]),
    ]);
    // Started reads are drained even if sending fails, so no late callback can launch a second account lane.
    let accepted: ReadyChoice | undefined;
    try {
      accepted = await executionQueue?.settle();
    } finally {
      this.observe((store) =>
        store.finishFound(
          this.settings.networkMode,
          chainId,
          choices.map((c) => c.candidate.trade.id),
          this.settings.mode,
        ),
      );
    }
    if (!accepted) {
      check();
      const error = reads.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (error) throw error.reason;
      if (quoteFailures && choices.length === 0)
        throw new Error("Quote failures prevented a healthy scan");
    }
    this.event("scan_complete", {
      chainId,
      candidates: choices.length,
      completedQuotes,
      quoteFailures,
      mode: this.settings.mode,
      submitted: !!accepted,
    });
  }
  private async executeChoice(
    chain: ChainConfig,
    client: PublicClient,
    choice: ReadyChoice,
    task?: ScanTask,
  ): Promise<boolean> {
    this.updateObservation(choice, { state: "rechecking", reason: null });
    try {
      const result = await this.executePricedChoice(
        chain,
        client,
        choice,
        task,
      );
      if (!result)
        this.updateObservation(choice, {
          state: "disappeared",
          reason:
            "The selected amount or direction was no longer available during recheck",
        });
      return result;
    } catch (error) {
      if (!(error instanceof FeeProfitRefusal)) {
        this.updateObservation(choice, {
          state:
            error instanceof ObsoleteScan ||
            error instanceof StaleCandidateError
              ? "stale"
              : "blocked",
          reason: safeError(error),
        });
        throw error;
      }
      this.updateObservation(choice, {
        state: "unprofitable",
        reason: "The candidate did not cover measured fees and required profit",
        estimatedFee: String(error.tokenCost),
        estimatedNet: String(error.conservativeGross - error.tokenCost),
      });
      this.event("fee_unprofitable", {
        chainId: chain.chainId,
        venue: choice.kind,
        baseToken: choice.startToken,
        grossProfitBeforeGas: error.conservativeGross,
        estimatedGasCost: error.tokenCost,
        requiredGross: error.requiredGross,
        sent: false,
        reason: "Measured fees exceed this candidate's safe profit margin",
      });
      // No signing/history reservation happened. Another ready route may still cover its own fees.
      return false;
    }
  }
  private async executePricedChoice(
    chain: ChainConfig,
    client: PublicClient,
    choice: ReadyChoice,
    task?: ScanTask,
  ): Promise<boolean> {
    const chainId = chain.chainId,
      check = () => {
        task?.assertActive();
        if (this.controls?.paused(chainId))
          throw new ObsoleteScan("New checks and trades are paused");
      };
    const execution = this.settings.execution[String(chainId)];
    if (!execution) throw new Error("No execution configuration");
    const vmContext = this.swapVMCatalog
      ? {
          client,
          chain,
          settings: this.settings,
          aqua: this.aqua,
          catalog: this.swapVMCatalog,
          onEvent: (event: string, data: Record<string, unknown>) =>
            this.event(event, data),
          check,
          signal: task?.signal,
          bindSnapshot: task?.adoptQuote,
        }
      : undefined;
    let { candidate } = choice;
    this.event("opportunity", {
      chainId,
      baseToken: choice.startToken,
      venue: choice.kind,
      amount: candidate.trade.first.amountIn,
      conservativeNetProfit: candidate.feeEstimate ? candidate.netProfit : null,
      grossProfitBeforeGas: candidate.quotedProfit,
      feeStatus: candidate.feeEstimate ? "estimated" : "unverified",
      aquaFirst: candidate.aquaFirst,
    });
    check();
    if (this.settings.mode === "observe") return false;
    if (!execution?.allowBroadcast)
      throw new Error("Broadcast disabled for chain");
    if (choice.kind === "aqua") {
      if (!vmContext) throw new Error("SwapVM catalog is not configured");
      const refreshed = await refreshSwapVMChoice(vmContext, choice);
      if (!refreshed) {
        this.event("opportunity_disappeared", { chainId, venue: "aqua" });
        return false;
      }
      const hash = await submit(
        client,
        chain,
        this.settings,
        refreshed,
        this.journal,
        this.history,
        undefined,
        (snapshot) => {
          check();
          if (snapshot)
            task?.bindExecutionSnapshot(snapshot.number, snapshot.hash);
          vmContext.catalog.assertApproved(choice.market, choice.policy);
        },
        (stage, details) =>
          this.executionProgress(choice, refreshed, chainId, stage, details),
      );
      this.updateObservation(choice, {
        state: "submitted",
        transactionHash: hash,
        executionTradeId: refreshed.trade.id,
        executionAmountIn: String(refreshed.trade.first.amountIn),
        reason:
          "Broadcast acknowledged; confirmed outcome belongs to transaction history",
      });
      this.metrics.submitted++;
      this.event("submitted", { chainId, hash, venue: "aqua" });
      return true;
    }
    const { market, pool, external } = choice;
    // Discovery can take many blocks. Refresh the selected size and direction before reserving JIT backing.
    const fresh = await client.getBlock();
    const [balance, currentLimits] = await Promise.all([
      client.readContract({
        address: market.baseToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [execution.executor],
        blockNumber: fresh.number,
      }),
      client.readContract({
        address: execution.executor,
        abi: executorAbi,
        functionName: "limits",
        args: [market.baseToken],
        blockNumber: fresh.number,
      }),
    ]);
    const inputCap = [
      market.maxInput,
      balance,
      currentLimits[0],
      (1n << 128n) - 1n,
    ].reduce((a, b) => (a < b ? a : b));
    if (inputCap <= 0n) return false;
    // Shared backing or either pool may have changed. Re-optimize the route, not only the old size.
    this.assertMarketApproval(market);
    check();
    let selected: Candidate | undefined;
    if (this.settings.v4Search.mode === "quote-grid") {
      const chosen = choice.candidate.trade.first.amountIn;
      selected = (
        await this.quoteGrid({
          client,
          chain,
          pool,
          market,
          external,
          inputCap,
          head: fresh,
          fixed: {
            amount: chosen < inputCap ? chosen : inputCap,
            aquaFirst: choice.candidate.aquaFirst,
          },
        })
      )[0];
    } else {
      const optimized = await this.aqua.optimize({
        chain,
        pool,
        market,
        external,
        network: this.settings.networkMode,
        maxInput: inputCap,
        gasBudget: 0n,
        slippageBps: this.settings.slippageBps,
        signal: task?.signal,
        executionPriority: true,
      });
      selected = optimized.candidates[0];
    }
    if (!selected) {
      this.event("opportunity_disappeared", { chainId });
      return false;
    }
    candidate = selected;
    await verifyV4Quote(client, candidate, this.settings, {
      signal: task?.signal,
      check,
    });
    if (candidate.quoteBlockHash)
      task?.adoptQuote(candidate.blockNumber, candidate.quoteBlockHash);
    const aquaLeg = candidate.aquaFirst
      ? candidate.trade.first
      : candidate.trade.second;
    check();
    this.assertMarketApproval(market);
    this.event("jit_authorization", { chainId });
    const auth = await this.aqua.authorize(
      chain,
      pool,
      market,
      aquaLeg.tokenIn,
      aquaLeg.amountIn,
    );
    check();
    aquaLeg.hookData = auth.hookData;
    candidate.trade.deadline =
      auth.deadline < candidate.trade.deadline
        ? auth.deadline
        : candidate.trade.deadline;
    const hash = await submit(
      client,
      chain,
      this.settings,
      candidate,
      this.journal,
      this.history,
      undefined,
      (snapshot) => {
        check();
        if (snapshot)
          task?.bindExecutionSnapshot(snapshot.number, snapshot.hash);
        this.assertMarketApproval(market);
      },
      (stage, details) =>
        this.executionProgress(choice, candidate, chainId, stage, details),
    );
    this.updateObservation(choice, {
      state: "submitted",
      transactionHash: hash,
      executionTradeId: candidate.trade.id,
      executionAmountIn: String(candidate.trade.first.amountIn),
      reason:
        "Broadcast acknowledged; confirmed outcome belongs to transaction history",
    });
    this.metrics.submitted++;
    this.event("submitted", { chainId, hash });
    return true;
  }
}
