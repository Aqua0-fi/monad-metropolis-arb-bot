import { waitForRpcHead } from "./rpc-head.js";
import { StaleCandidateError } from "./freshness.js";
import { ObsoleteScan } from "./head-scheduler.js";
import { safeError } from "./diagnostics.js";
import { forEachConcurrent } from "./opportunity-queue.js";
import { erc20Abi, type Address, type PublicClient } from "viem";
import { executorAbi } from "./abi.js";
import { same, type ChainConfig, type Settings } from "./config.js";
import { assertFresh, type Candidate } from "./strategy.js";
import { discoverCached, type ExternalPool } from "./venues.js";
import type { AquaClient } from "./aqua.js";
import type { SwapVMMarketCatalog } from "./swapvm-catalog.js";
import type { SwapVMMarket } from "./swapvm.js";
import type { MarketPolicy } from "./market-catalog.js";

export interface SwapVMChoice {
  kind: "aqua";
  candidate: Candidate;
  startToken: Address;
  market: SwapVMMarket;
  policy: MarketPolicy;
  external: ExternalPool;
  inputCap: bigint;
}
interface SearchContext {
  bindSnapshot?: ((number: bigint, hash: `0x${string}`) => void) | undefined;
  onCandidate?: ((choice: SwapVMChoice) => void) | undefined;
  signal?: AbortSignal | undefined;
  check?: (() => void) | undefined;
  client: PublicClient;
  chain: ChainConfig;
  settings: Settings;
  aqua: AquaClient;
  catalog: SwapVMMarketCatalog;
  onEvent: (event: string, data: Record<string, unknown>) => void;
}
export async function collectSwapVMChoices(
  context: SearchContext,
): Promise<SwapVMChoice[]> {
  const { client, chain, settings, aqua, catalog } = context;
  const execution = settings.execution[String(chain.chainId)];
  const caller =
    execution?.executor ?? settings.quoteFees[String(chain.chainId)]?.caller;
  const markets = catalog
    .list()
    .markets.filter(
      (entry) =>
        entry.market.chainId === chain.chainId &&
        entry.readyToQuote &&
        entry.policy,
    );
  if (!markets.length) return [];
  if (!caller) {
    context.onEvent("swapvm_quote_blocked", {
      chainId: chain.chainId,
      reason:
        "Configure the intended executor/caller; opaque VM quotes must not silently use a different msg.sender",
    });
    return [];
  }
  const choices: SwapVMChoice[] = [];
  await forEachConcurrent(
    markets,
    2,
    async ({ market, policy: supplied }) => {
      if (context.signal?.aborted) return;
      context.check?.();
      const policy = supplied!;
      const startToken = policy.baseToken as Address;
      const block = await client.getBlock();
      let inputCap = BigInt(policy.maxInput);
      if (inputCap >= 1n << 128n) inputCap = (1n << 128n) - 1n;
      if (settings.mode === "execute") {
        if (!execution) throw new Error("No funded execution configuration");
        const [balance, limit] = await Promise.all([
          client.readContract({
            address: startToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [execution.executor],
            blockNumber: block.number,
          }),
          client.readContract({
            address: execution.executor,
            abi: executorAbi,
            functionName: "limits",
            args: [startToken],
            blockNumber: block.number,
          }),
        ]);
        if (balance < inputCap) inputCap = balance;
        if (limit[0] < inputCap) inputCap = limit[0];
      }
      if (inputCap <= 0n) return;
      const pools = await discoverCached(
        client,
        chain,
        { currency0: market.token0, currency1: market.token1 },
        block.number,
      );
      await forEachConcurrent(
        execution?.externalPools
          ? pools.filter((pool) =>
              execution.externalPools!.some((allowed) =>
                same(allowed, pool.address),
              ),
            )
          : pools,
        2,
        async (external) => {
          if (context.signal?.aborted) return;
          try {
            context.check?.();
            catalog.assertApproved(market, policy);
            const result = await aqua.optimizeSwapVM({
              chain,
              market,
              policy,
              external,
              caller,
              network: settings.networkMode,
              maxInput: inputCap,
              // Gross-only screening; exact fees are required by the full-transaction gate.
              gasBudget: 0n,
              slippageBps: settings.slippageBps,
              signal: context.signal,
            });
            context.check?.();
            context.onEvent("swapvm_automatic_sizing", {
              chainId: chain.chainId,
              strategyId: market.stableStrategyId,
              externalPool: external.address,
              searches: result.searches,
            });
            for (const candidate of result.candidates) {
              if (context.signal?.aborted) return;
              const quoteHead = await waitForRpcHead(
                client,
                candidate.blockNumber,
                candidate.quotedAt + settings.maxQuoteAgeMs,
                {
                  pollMs: settings.scheduling.headerPollMs,
                  signal: context.signal,
                },
              );
              assertFresh(
                candidate,
                quoteHead.number,
                Date.now(),
                settings.maxQuoteAgeMs,
                settings.maxBlockLag,
              );
              if (
                !candidate.quoteBlockHash ||
                (await client.getBlock({ blockNumber: candidate.blockNumber }))
                  .hash !== candidate.quoteBlockHash
              )
                throw new Error("SwapVM quote block reorganized");
              context.check?.();
              catalog.assertApproved(market, policy);
              const choice: SwapVMChoice = {
                kind: "aqua",
                candidate,
                startToken,
                market,
                policy,
                external,
                inputCap,
              };
              choices.push(choice);
              context.onCandidate?.(choice);
            }
          } catch (error) {
            if (context.signal?.aborted) return;
            if (
              error instanceof ObsoleteScan ||
              error instanceof StaleCandidateError
            )
              throw error;
            context.onEvent("swapvm_sizing_rejected", {
              chainId: chain.chainId,
              strategyId: market.stableStrategyId,
              externalPool: external.address,
              reason: safeError(error),
            });
          }
        },
        context.signal,
      );
    },
    context.signal,
  );
  return choices;
}

/** The search result is provisional. Re-quote only the chosen size at fresh state and the real caller. */
export async function refreshSwapVMChoice(
  context: SearchContext,
  choice: SwapVMChoice,
): Promise<Candidate | null> {
  const { chain, client, settings, aqua, catalog } = context;
  const execution = settings.execution[String(chain.chainId)];
  if (!execution?.allowBroadcast || settings.mode !== "execute")
    throw new Error("Trading is not enabled");
  catalog.assertApproved(choice.market, choice.policy);
  const fresh = await client.getBlock();
  const [balance, limit] = await Promise.all([
    client.readContract({
      address: choice.startToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [execution.executor],
      blockNumber: fresh.number,
    }),
    client.readContract({
      address: execution.executor,
      abi: executorAbi,
      functionName: "limits",
      args: [choice.startToken],
      blockNumber: fresh.number,
    }),
  ]);
  const cap = [
    BigInt(choice.policy.maxInput),
    balance,
    limit[0],
    (1n << 128n) - 1n,
  ].reduce((a, b) => (a < b ? a : b));
  const selectedAmount = choice.candidate.trade.first.amountIn;
  if (selectedAmount <= 0n || selectedAmount > cap) return null;
  const result = await aqua.optimizeSwapVM({
    chain,
    market: choice.market,
    policy: choice.policy,
    external: choice.external,
    caller: execution.executor,
    network: settings.networkMode,
    maxInput: cap,
    fixedAmount: selectedAmount,
    executionPriority: true,
    gasBudget: 0n,
    slippageBps: settings.slippageBps,
    signal: context.signal,
    // Refresh the selected amount once. A changed cap/failed fill returns to discovery;
    // repeating an entire adaptive search here races the same freshness window again.
  });
  const candidate = result.candidates.find(
    (c) => c.aquaFirst === choice.candidate.aquaFirst,
  );
  if (!candidate) {
    context.check?.();
    return null;
  }
  const quoteHead = await waitForRpcHead(
    client,
    candidate.blockNumber,
    candidate.quotedAt + settings.maxQuoteAgeMs,
    { pollMs: settings.scheduling.headerPollMs, signal: context.signal },
  );
  assertFresh(
    candidate,
    quoteHead.number,
    Date.now(),
    settings.maxQuoteAgeMs,
    settings.maxBlockLag,
  );
  if (
    (await client.getBlock({ blockNumber: candidate.blockNumber })).hash !==
    candidate.quoteBlockHash
  )
    throw new Error("Refreshed SwapVM quote block reorganized");
  if (candidate.quoteBlockHash)
    context.bindSnapshot?.(candidate.blockNumber, candidate.quoteBlockHash);
  context.check?.();
  catalog.assertApproved(choice.market, choice.policy);
  return candidate;
}
