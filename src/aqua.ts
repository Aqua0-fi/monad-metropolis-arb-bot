import { ReadPool } from "./read-pool.js";
import { z } from "zod";
import {
  address,
  hex,
  positive,
  uint,
  same,
  type ChainConfig,
  type Market,
  type Pool,
} from "./config.js";
import type { Address, Hex } from "viem";
import {
  acceptSwapVMOptimization,
  type SwapVMSizingRequest,
} from "./swapvm.js";
import { acceptOptimizedCandidates, type SizingRequest } from "./sizing.js";
import {
  BackendBudget,
  DEFAULT_BUDGET_LIMITS,
  type BackendCallClass,
} from "./backend-budget.js";
export const MIN_SQRT = 4295128740n;
export const MAX_SQRT = 1461446703485210103287273052203988822378723970341n;
const quoteSchema = z.object({
  quote: z.object({
    amountIn: positive,
    amountOut: positive,
    amountInToken: address,
    amountOutToken: address,
    execution: z.object({
      requestedAmountIn: positive,
      authorizedAmountIn: positive,
      authorizedAmountOut: positive,
      fullySupported: z.boolean(),
      wasClamped: z.boolean(),
    }),
  }),
});
const authSchema = z.object({
  hookData: hex,
  authorization: z.object({
    executor: address,
    deadline: positive,
    poolId: hex,
    classId: uint,
    nonce: uint,
  }),
});
/** Thrown when Aqua0 can back less than requested; carries the backed input so search can shrink. */
export class AquaCapacityLimit extends Error {
  constructor(
    readonly requested: bigint,
    readonly backed: bigint,
  ) {
    super(
      `Aqua0 can back ${backed} of the requested ${requested}; not a full fill`,
    );
  }
}
export function validateQuote(
  raw: unknown,
  input: Address,
  output: Address,
  amount: bigint,
): bigint {
  const { quote: q } = quoteSchema.parse(raw);
  if (
    (q.execution.wasClamped || !q.execution.fullySupported) &&
    q.execution.requestedAmountIn === amount &&
    q.execution.authorizedAmountIn < amount &&
    same(q.amountInToken, input) &&
    same(q.amountOutToken, output)
  )
    throw new AquaCapacityLimit(amount, q.execution.authorizedAmountIn);
  if (
    !q.execution.fullySupported ||
    q.execution.wasClamped ||
    q.amountIn !== amount ||
    q.execution.requestedAmountIn !== amount ||
    q.execution.authorizedAmountIn !== amount ||
    !same(q.amountInToken, input) ||
    !same(q.amountOutToken, output)
  )
    throw new Error("Aqua0 partial fill or token mismatch");
  return q.amountOut < q.execution.authorizedAmountOut
    ? q.amountOut
    : q.execution.authorizedAmountOut;
}
export class AquaClient {
  private readonly searchReads = new ReadPool(4);
  searchStatus() {
    return this.searchReads.status();
  }
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    // Every request passes this budget first; there is no unbudgeted path to the backend.
    readonly budget: BackendBudget = new BackendBudget(DEFAULT_BUDGET_LIMITS),
    // Sent only on /authorize, the one route that needs operator tier.
    private readonly operatorKey?: string,
  ) {}
  private spend(callClass: BackendCallClass) {
    this.budget.take(callClass);
  }
  private async post(
    path: string,
    body: unknown,
    timeout = 10000,
    signal?: AbortSignal,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const response = await fetch(new URL(path, this.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.headers,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Aqua0 ${path} HTTP ${response.status}`);
    return response.json();
  }
  async listPools(chain: ChainConfig): Promise<unknown> {
    this.spend("catalog");
    const url = new URL("/api/vaults/pools", this.url);
    url.searchParams.set("chainId", String(chain.chainId));
    url.searchParams.set("includeArming", "true");
    const response = await fetch(url, {
      headers: { ...this.headers },
      signal: AbortSignal.timeout(12000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`Public V4 discovery HTTP ${response.status}`);
    if (
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("application/json")
    )
      throw new Error("Public V4 discovery returned non-JSON data");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Public V4 discovery returned an empty body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 4 * 1024 * 1024)
          throw new Error(
            "Public V4 discovery exceeds the bounded response size",
          );
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  private body(
    chain: ChainConfig,
    pool: Pool,
    market: Market,
    input: Address,
    amount: bigint,
  ) {
    const zeroForOne = same(input, pool.currency0);
    return {
      venue: "v4",
      chainId: chain.chainId,
      poolId: pool.poolId,
      classId: market.classId.toString(),
      token0: pool.currency0,
      token1: pool.currency1,
      fee: pool.fee,
      tickSpacing: pool.tickSpacing,
      swapDirection: zeroForOne ? "zeroForOne" : "oneForZero",
      tradeType: "exactIn",
      ...(zeroForOne
        ? { requestedAmount0: amount.toString() }
        : { requestedAmount1: amount.toString() }),
    };
  }
  async listSwapVM(chain: ChainConfig): Promise<unknown> {
    this.spend("catalog");
    const endpoint = new URL("/api/swap/aqua-markets", this.url);
    endpoint.searchParams.set("chainId", String(chain.chainId));
    const response = await fetch(endpoint, {
      headers: this.headers,
      signal: AbortSignal.timeout(25000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`SwapVM discovery HTTP ${response.status}`);
    return response.json();
  }
  async optimizeSwapVM(request: SwapVMSizingRequest) {
    return this.searchReads.run(
      async () => {
        this.spend("search");
        const quotedAt = Date.now();
        const raw = await this.post(
          "/api/swap/optimize-aqua-round-trip",
          {
            venue: "aqua",
            chainId: request.chain.chainId,
            stableStrategyId: request.market.stableStrategyId,
            caller: request.caller,
            baseToken: request.policy.baseToken,
            externalPool: request.external.address,
            externalFactory: request.external.venue.factory,
            maxInput: request.maxInput.toString(),
            gasBudget: request.gasBudget.toString(),
            minNetProfit: request.policy.minNetProfit,
            slippageBps: request.slippageBps,
            ...(request.fixedAmount === undefined
              ? {}
              : { fixedAmount: request.fixedAmount.toString() }),
          },
          30000,
          request.signal,
        );
        return acceptSwapVMOptimization(raw, request, quotedAt);
      },
      request.signal,
      request.executionPriority ? 1 : 0,
      String(request.chain.chainId),
    );
  }

  async optimize(request: Omit<SizingRequest, "quotedAt">) {
    return this.searchReads.run(
      async () => {
        this.spend("search");
        const quotedAt = Date.now();
        const { chain, pool, market, external } = request;
        const raw = await this.post(
          "/api/swap/optimize-round-trip",
          {
            venue: "v4",
            chainId: chain.chainId,
            poolId: pool.poolId,
            classId: market.classId.toString(),
            token0: pool.currency0,
            token1: pool.currency1,
            fee: pool.fee,
            tickSpacing: pool.tickSpacing,
            baseToken: market.baseToken,
            externalPool: external.address,
            externalFactory: external.venue.factory,
            maxInput: request.maxInput.toString(),
            minNetProfit: market.minNetProfit.toString(),
            gasBudget: request.gasBudget.toString(),
            slippageBps: request.slippageBps,
          },
          10000,
          request.signal,
        );
        return acceptOptimizedCandidates(raw, { ...request, quotedAt });
      },
      request.signal,
      request.executionPriority ? 1 : 0,
      String(request.chain.chainId),
    );
  }

  async quote(
    chain: ChainConfig,
    pool: Pool,
    market: Market,
    input: Address,
    amount: bigint,
  ): Promise<bigint> {
    const out = same(input, pool.currency0) ? pool.currency1 : pool.currency0;
    this.spend("search");
    return validateQuote(
      await this.post(
        "/api/swap/quote",
        this.body(chain, pool, market, input, amount),
      ),
      input,
      out,
      amount,
    );
  }
  async authorize(
    chain: ChainConfig,
    pool: Pool,
    market: Market,
    input: Address,
    amount: bigint,
  ): Promise<{ hookData: Hex; deadline: bigint }> {
    this.spend("authorize");
    const raw = await this.post(
      "/api/swap/authorize",
      {
        ...this.body(chain, pool, market, input, amount),
        amountSpecified: (-amount).toString(),
        sqrtPriceLimitX96: (same(input, pool.currency0)
          ? MIN_SQRT
          : MAX_SQRT
        ).toString(),
      },
      10000,
      undefined,
      this.operatorKey ? { "X-Operator-Key": this.operatorKey } : {},
    );
    const auth = authSchema.parse(raw);
    if (
      !same(auth.authorization.executor, chain.universalRouter) ||
      !same(auth.authorization.poolId, pool.poolId) ||
      auth.authorization.classId !== market.classId ||
      auth.hookData.length < 66
    )
      throw new Error("Aqua0 authorization binding mismatch");
    return { hookData: auth.hookData, deadline: auth.authorization.deadline };
  }
}
