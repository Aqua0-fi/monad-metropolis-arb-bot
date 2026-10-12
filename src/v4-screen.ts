import { erc20Abi, type Address, type PublicClient } from "viem";
import { stateViewAbi, v3Abi } from "./abi.js";
import { same, type ChainConfig, type Market, type Pool } from "./config.js";
import type { Settings } from "./config.js";
import { haircut } from "./strategy.js";
import { quoteV3, type ExternalPool } from "./venues.js";

/**
 * Free screening for the Aqua0 V4 route. Aqua0's JIT hook fills at the backend's reference feed
 * price (it moves its empty pool to the signed start price before every swap), so the Aqua0 leg can
 * be estimated from the same public feed with no backend call. The external leg is an exact
 * QuoterV2 read on the worker's own RPC. Only a screen that clears every fee, the slippage haircut,
 * the gas allowance and a margin may spend a backend quote.
 */
export type FeedQuote = { priceUsd: number; observedAtMs: number | null };
export type ScreenResult =
  | {
      go: true;
      reason: string;
      fingerprint: string;
      amount: bigint;
      aquaFirst: boolean;
      expectedProfit: bigint;
      required: bigint;
    }
  | {
      go: false;
      reason: string;
      fingerprint?: string;
      expectedProfit?: bigint;
      required?: bigint;
    };
type V4Search = Settings["v4Search"];
const USD_STABLE = "usd-stable";

export class FeedPrices {
  private cache = new Map<string, { at: number; quote: FeedQuote }>();
  private inflight = new Map<string, Promise<void>>();
  constructor(
    private readonly settings: V4Search,
    private readonly fetchJson: (url: string) => Promise<unknown> = async (
      url,
    ) => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Price feed HTTP ${response.status}`);
      return response.json();
    },
    private readonly now: () => number = Date.now,
  ) {}
  keyFor(token: Address): string | undefined {
    return this.settings.feedKeys[token.toLowerCase()];
  }
  /** Fresh feed quotes for both tokens, or a reason why the screen must not proceed. */
  async pair(
    a: Address,
    b: Address,
  ): Promise<[FeedQuote, FeedQuote] | { refused: string }> {
    const keys = [this.keyFor(a), this.keyFor(b)];
    if (!keys[0] || !keys[1])
      return { refused: "No reviewed feed key for this pair" };
    const remote = keys.filter((k) => k !== USD_STABLE) as string[];
    const stale = remote.filter((k) => {
      const hit = this.cache.get(k);
      return !hit || this.now() - hit.at >= this.settings.feedRefreshMs;
    });
    if (stale.length) await this.refresh(stale);
    const out: FeedQuote[] = [];
    for (const key of keys as string[]) {
      if (key === USD_STABLE) {
        out.push({ priceUsd: 1, observedAtMs: null });
        continue;
      }
      const hit = this.cache.get(key);
      if (!hit) return { refused: `No feed price for ${key}` };
      if (
        hit.quote.observedAtMs !== null &&
        this.now() - hit.quote.observedAtMs > this.settings.feedMaxAgeMs
      )
        return { refused: `Feed price for ${key} is stale` };
      out.push(hit.quote);
    }
    return [out[0]!, out[1]!];
  }
  private async refresh(keys: string[]) {
    const id = [...keys].sort().join(",");
    let pending = this.inflight.get(id);
    if (!pending) {
      pending = (async () => {
        const raw = (await this.fetchJson(
          `${this.settings.feedUrl.replace(/\/$/, "")}/${id}`,
        )) as {
          coins?: Record<string, { price?: unknown; timestamp?: unknown }>;
        };
        for (const key of keys) {
          const coin = raw?.coins?.[key];
          const price = Number(coin?.price);
          const seconds = Number(coin?.timestamp);
          if (!Number.isFinite(price) || price <= 0) continue;
          this.cache.set(key, {
            at: this.now(),
            quote: {
              priceUsd: price,
              observedAtMs: Number.isFinite(seconds) ? seconds * 1000 : 0,
            },
          });
        }
      })().finally(() => this.inflight.delete(id));
      this.inflight.set(id, pending);
    }
    await pending;
  }
}

/** Fixed-point USD price, so the Aqua0 leg estimate stays in exact integer math. */
function scaled(price: number): bigint {
  return BigInt(Math.round(price * 1e12)) * 10n ** 6n;
}
export function aquaOutEstimate(p: {
  amountIn: bigint;
  priceIn: number;
  priceOut: number;
  decimalsIn: number;
  decimalsOut: number;
  feePips: number;
}): bigint {
  const pIn = scaled(p.priceIn),
    pOut = scaled(p.priceOut);
  if (pIn <= 0n || pOut <= 0n) return 0n;
  return (
    (p.amountIn *
      pIn *
      10n ** BigInt(p.decimalsOut) *
      BigInt(1_000_000 - p.feePips)) /
    (pOut * 10n ** BigInt(p.decimalsIn) * 1_000_000n)
  );
}

type AquaPricing =
  | { kind: "feed"; feed: [FeedQuote, FeedQuote] }
  | { kind: "pool"; sqrtPriceX96: bigint; feePips: number };

/** Output at the pool's current marginal price less its LP fee; depth is confirmed by the backend quote. */
export function poolOutEstimate(
  amountIn: bigint,
  sqrtPriceX96: bigint,
  zeroForOne: boolean,
  feePips: number,
): bigint {
  const afterFee = (amountIn * BigInt(1_000_000 - feePips)) / 1_000_000n;
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  return zeroForOne
    ? (afterFee * priceX192) >> 192n
    : (afterFee << 192n) / priceX192;
}

export class V4Screen {
  private decimals = new Map<string, number>();
  private last = new Map<
    string,
    { fingerprint: string; result: ScreenResult }
  >();
  private backend = new Map<
    string,
    { at: number; fingerprint: string; found: boolean }
  >();
  // Aqua0-leg input the backend last said it can back, per market and route order.
  private capacity = new Map<string, { at: number; backed: bigint }>();
  static readonly CAPACITY_TTL_MS = 5 * 60_000;
  noteCapacity(key: string, aquaFirst: boolean, backed: bigint) {
    this.capacity.set(`${key}:${aquaFirst}`, { at: this.now(), backed });
    this.last.delete(key);
  }
  private backedLimit(key: string, aquaFirst: boolean): bigint | undefined {
    const hit = this.capacity.get(`${key}:${aquaFirst}`);
    if (!hit || this.now() - hit.at > V4Screen.CAPACITY_TTL_MS) return;
    // Stay inside the reported backing; it can shrink between reads.
    return (hit.backed * 98n) / 100n;
  }
  constructor(
    private readonly settings: V4Search,
    private readonly slippageBps: number,
    readonly feed: FeedPrices = new FeedPrices(settings),
    private readonly now: () => number = Date.now,
  ) {}
  static key(chainId: number, pool: Pool, external: ExternalPool) {
    return `${chainId}:${pool.poolId.toLowerCase()}:${external.address.toLowerCase()}`;
  }
  private async tokenDecimals(client: PublicClient, token: Address) {
    const hit = this.decimals.get(token.toLowerCase());
    if (hit !== undefined) return hit;
    const value = Number(
      await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "decimals",
      }),
    );
    this.decimals.set(token.toLowerCase(), value);
    return value;
  }
  /** Record the backend's answer so an unchanged market is never asked about twice. */
  noteBackend(key: string, fingerprint: string, found: boolean) {
    this.backend.set(key, { at: this.now(), fingerprint, found });
  }
  async screen(p: {
    client: PublicClient;
    chain: ChainConfig;
    pool: Pool;
    market: Market;
    external: ExternalPool;
    inputCap: bigint;
    blockNumber: bigint;
  }): Promise<ScreenResult> {
    const key = V4Screen.key(p.chain.chainId, p.pool, p.external);
    const base = p.market.baseToken;
    const other = same(base, p.pool.currency0)
      ? p.pool.currency1
      : p.pool.currency0;
    // A hook that no longer recentres fills from wherever its pool price sits, so that price IS the
    // Aqua0 side. A recentring hook fills at the backend's feed price instead.
    let pricing: AquaPricing;
    if (this.settings.aquaPrice === "pool") {
      const stateView = this.settings.stateView[String(p.chain.chainId)];
      if (!stateView)
        return { go: false, reason: "No StateView configured for this chain" };
      const [sqrtPriceX96, , , lpFee] = await p.client.readContract({
        address: stateView,
        abi: stateViewAbi,
        functionName: "getSlot0",
        args: [p.pool.poolId],
        blockNumber: p.blockNumber,
      });
      if (sqrtPriceX96 === 0n)
        return { go: false, reason: "Aqua0 pool is not initialized" };
      pricing = { kind: "pool", sqrtPriceX96, feePips: Number(lpFee) };
    } else {
      const feed = await this.feed.pair(base, other);
      if ("refused" in feed) return { go: false, reason: feed.refused };
      pricing = { kind: "feed", feed };
    }
    const [slot0, liquidity] = await Promise.all([
      p.client.readContract({
        address: p.external.address,
        abi: v3Abi,
        functionName: "slot0",
        blockNumber: p.blockNumber,
      }),
      p.client.readContract({
        address: p.external.address,
        abi: v3Abi,
        functionName: "liquidity",
        blockNumber: p.blockNumber,
      }),
    ]);
    if (liquidity === 0n)
      return { go: false, reason: "External pool has no active liquidity" };
    const fingerprint = JSON.stringify([
      String(slot0[0]),
      String(liquidity),
      pricing.kind === "pool"
        ? String(pricing.sqrtPriceX96)
        : pricing.feed.map((q) => q.priceUsd.toPrecision(7)),
      String(p.inputCap),
    ]);
    const asked = this.backend.get(key);
    if (asked && asked.fingerprint === fingerprint && !asked.found)
      return {
        go: false,
        reason:
          "Unchanged since the backend last found no profitable fill; not asking again",
        fingerprint,
      };
    if (asked && this.now() - asked.at < this.settings.minBackendIntervalMs)
      return {
        go: false,
        reason: "Backend cooldown for this market",
        fingerprint,
      };
    const cached = this.last.get(key);
    if (cached && cached.fingerprint === fingerprint) return cached.result;
    const result = await this.evaluate(
      p,
      base,
      other,
      pricing,
      fingerprint,
      key,
    );
    this.last.set(key, { fingerprint, result });
    return result;
  }
  private async evaluate(
    p: Parameters<V4Screen["screen"]>[0],
    base: Address,
    other: Address,
    pricing: AquaPricing,
    fingerprint: string,
    key: string,
  ): Promise<ScreenResult> {
    const [dBase, dOther] = await Promise.all([
      this.tokenDecimals(p.client, base),
      this.tokenDecimals(p.client, other),
    ]);
    const n = BigInt(this.settings.sizesPerScreen);
    const sizes = [
      ...new Set(
        (p.market.amounts.length
          ? p.market.amounts.filter((a) => a <= p.inputCap)
          : Array.from(
              { length: Number(n) },
              (_, i) => (p.inputCap * BigInt(i + 1)) / n,
            )
        ).filter((a) => a > 0n),
      ),
    ];
    if (!sizes.length) return { go: false, reason: "No size within the cap" };
    const baseIsToken0 = same(base, p.pool.currency0);
    const aqua = (amountIn: bigint, toOther: boolean) =>
      pricing.kind === "pool"
        ? poolOutEstimate(
            amountIn,
            pricing.sqrtPriceX96,
            toOther === baseIsToken0,
            pricing.feePips,
          )
        : aquaOutEstimate({
            amountIn,
            priceIn: toOther
              ? pricing.feed[0].priceUsd
              : pricing.feed[1].priceUsd,
            priceOut: toOther
              ? pricing.feed[1].priceUsd
              : pricing.feed[0].priceUsd,
            decimalsIn: toOther ? dBase : dOther,
            decimalsOut: toOther ? dOther : dBase,
            feePips: p.pool.fee,
          });
    const v3 = (tokenIn: Address, tokenOut: Address, amountIn: bigint) =>
      quoteV3(
        p.client,
        p.external.venue.quoter,
        p.external.fee,
        tokenIn,
        tokenOut,
        amountIn,
        p.blockNumber,
      ).catch(() => 0n);
    let best:
      | { amount: bigint; aquaFirst: boolean; profit: bigint; required: bigint }
      | undefined;
    for (const amount of sizes)
      for (const aquaFirst of [true, false]) {
        const backed = this.backedLimit(key, aquaFirst);
        if (aquaFirst && backed !== undefined && amount > backed) continue;
        const out1 = aquaFirst
          ? aqua(amount, true)
          : await v3(base, other, amount);
        const secondIn = haircut(out1, this.slippageBps);
        if (secondIn === 0n) continue;
        if (!aquaFirst && backed !== undefined && secondIn > backed) continue;
        const out2 = aquaFirst
          ? await v3(other, base, secondIn)
          : aqua(secondIn, false);
        const profit = haircut(out2, this.slippageBps) - amount;
        const required =
          p.market.minNetProfit +
          (p.market.screenGasCost ?? 0n) +
          (amount * BigInt(this.settings.marginBps)) / 10_000n;
        const margin = profit - required;
        if (!best || margin > best.profit - best.required)
          best = { amount, aquaFirst, profit, required };
      }
    if (!best) return { go: false, reason: "No quotable size", fingerprint };
    if (best.profit < best.required)
      return {
        go: false,
        reason: "Free screen shows no gap after fees, slippage and gas",
        fingerprint,
        expectedProfit: best.profit,
        required: best.required,
      };
    return {
      go: true,
      reason: "Free screen shows a profitable gap",
      fingerprint,
      amount: best.amount,
      aquaFirst: best.aquaFirst,
      expectedProfit: best.profit,
      required: best.required,
    };
  }
}
