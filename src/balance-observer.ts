import { erc20Abi, getAddress, type Address, type PublicClient } from "viem";
import { forEachConcurrent } from "./opportunity-queue.js";
import type { ChainConfig, Settings } from "./config.js";
import {
  balanceObservationSchema,
  type BalanceObservation,
} from "./observation-wire.js";
import type { ObservationStore } from "./observations.js";

export interface BalanceTarget {
  role: "executor" | "operator";
  wallet: string;
  asset: string | null;
}
export function configuredBalanceTargets(
  chain: ChainConfig,
  settings: Settings,
  extraAssets: readonly string[] = [],
): BalanceTarget[] {
  const config = settings.execution[String(chain.chainId)];
  if (!config) return [];
  const tokens = [
    ...new Set(
      [
        config.wrappedNative,
        ...extraAssets,
        ...chain.pools.flatMap((p) => [p.currency0, p.currency1]),
        ...settings.markets
          .filter((m) => m.chainId === chain.chainId)
          .map((m) => m.baseToken),
      ].map((s) => getAddress(s).toLowerCase()),
    ),
  ];
  if (tokens.length > 32)
    throw Error(
      "Balance sampling asset scope exceeds the bounded known registry set",
    );
  return (["executor", "operator"] as const).flatMap((role) =>
    [null, ...tokens].map((asset) => ({
      role,
      wallet: getAddress(config[role]).toLowerCase(),
      asset,
    })),
  );
}
/** Side-channel observations only. These values do not authorize a trade or replace receipt P&L. */
export async function sampleBalances(
  client: PublicClient,
  chain: ChainConfig,
  network: "mainnet" | "fork",
  targets: readonly BalanceTarget[],
  clock = Date.now,
): Promise<BalanceObservation[]> {
  if (targets.length > 66)
    throw Error("Balance sample target count is unbounded");
  const observedAt = new Date(clock()).toISOString();
  const rows: BalanceObservation[] = targets.map((target) =>
    balanceObservationSchema.parse({
      ...target,
      network,
      chainId: chain.chainId,
      symbol:
        target.asset === null ? (chain.nativeCurrency?.symbol ?? null) : null,
      decimals:
        target.asset === null ? (chain.nativeCurrency?.decimals ?? null) : null,
      amount: null,
      blockNumber: null,
      blockHash: null,
      blockTimestamp: null,
      observedAt,
      source: "periodic",
      issue: "Balance read unavailable",
    }),
  );
  try {
    if ((await client.getChainId()) !== chain.chainId)
      throw Error("Wrong chain");
    const block = await client.getBlock();
    if (!block.hash) throw Error("Missing canonical head");
    const timestamp = new Date(Number(block.timestamp) * 1000).toISOString();
    await forEachConcurrent(rows, 2, async (row) => {
      row.blockNumber = String(block.number);
      row.blockHash = block.hash;
      row.blockTimestamp = timestamp;
      try {
        let amount: bigint;
        if (row.asset === null) {
          if (row.decimals === null || row.symbol === null)
            throw Error("Unknown native units");
          amount = await client.getBalance({
            address: row.wallet as Address,
            blockNumber: block.number,
          });
        } else {
          const [balance, decimals, symbol] = await Promise.all([
            client.readContract({
              address: row.asset as Address,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [row.wallet as Address],
              blockNumber: block.number,
            }),
            client.readContract({
              address: row.asset as Address,
              abi: erc20Abi,
              functionName: "decimals",
              blockNumber: block.number,
            }),
            client.readContract({
              address: row.asset as Address,
              abi: erc20Abi,
              functionName: "symbol",
              blockNumber: block.number,
            }),
          ]);
          if (decimals > 36 || !symbol || symbol.length > 32)
            throw Error("Token metadata mismatch");
          amount = balance;
          row.decimals = decimals;
          row.symbol = symbol;
        }
        if (amount < 0n) throw Error("Invalid balance");
        row.amount = String(amount);
        row.issue = null;
      } catch {
        row.amount = null;
        row.issue = "Balance or token metadata could not be read at this block";
      }
    });
    if (
      (await client.getBlock({ blockNumber: block.number })).hash !== block.hash
    )
      for (const row of rows) {
        row.amount = null;
        row.issue = "Block reorganized during balance sampling";
      }
  } catch {
    for (const row of rows) {
      row.amount = null;
      row.issue =
        "Canonical balance state was unavailable; no zero balance assumed";
    }
  }
  return rows.map((row) => balanceObservationSchema.parse(row));
}

/** One outstanding sample at most. RPC work is not awaited by the execution lane. */
export function startBalanceObserver(options: {
  chains: readonly ChainConfig[];
  settings: Settings;
  store: ObservationStore;
  client: (chain: ChainConfig) => PublicClient;
  intervalMs: number;
  assets?: (chain: ChainConfig) => readonly string[];
  signal?: AbortSignal;
  onIssue?: (message: string) => void;
}) {
  if (
    !Number.isSafeInteger(options.intervalMs) ||
    options.intervalMs < 30000 ||
    options.intervalMs > 3600000
  )
    throw Error("Invalid balance sample interval");
  let stopped = false,
    pending: Promise<void> | undefined;
  const status = {
    intervalMs: options.intervalMs,
    lastSampleAt: null as string | null,
    lastIssue: null as string | null,
  };
  const run = () => {
    if (stopped || pending) return;
    pending = (async () => {
      try {
        let missingReads = false;
        for (const chain of options.chains) {
          if (stopped || options.signal?.aborted) return;
          const targets = configuredBalanceTargets(
            chain,
            options.settings,
            options.assets?.(chain),
          );
          if (targets.length === 0) continue;
          const rows = await sampleBalances(
            options.client(chain),
            chain,
            options.settings.networkMode,
            targets,
          );
          if (stopped || options.signal?.aborted) return;
          for (const row of rows) {
            options.store.balance(row);
            missingReads ||= row.issue !== null;
          }
        }
        status.lastSampleAt = new Date().toISOString();
        status.lastIssue = missingReads
          ? "Some sampled balances are unavailable; the history records gaps, not zero balances"
          : null;
      } catch {
        status.lastIssue =
          "Balance observation storage or sampling is unavailable";
        options.onIssue?.(status.lastIssue);
      }
    })().finally(() => {
      pending = undefined;
    });
  };
  const timer = setInterval(run, options.intervalMs);
  timer.unref();
  run();
  return {
    status: () => ({ ...status, running: !!pending }),
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await pending;
    },
  };
}
