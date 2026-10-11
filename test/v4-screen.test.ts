import test from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { FeedPrices, V4Screen, aquaOutEstimate } from "../src/v4-screen.js";
import { settingsSchema } from "../src/config.js";
import { AquaCapacityLimit, validateQuote } from "../src/aqua.js";

const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as const;
const USDT0 = "0xe7cd86e13AC4309349F30B3435a9d337750fC82D" as const;
const WETH = "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242" as const;
const EXTERNAL = "0xacf82ECC826A9fc2D8c8C4d370d2D268fA5B3500" as const;
const pool = {
  poolId:
    "0x26d1028fae5935b2553bcd7299884fb2150e9f5b135059fe49b9b8222aa3daad" as const,
  currency0: USDC,
  currency1: USDT0,
  fee: 100,
  tickSpacing: 1,
  hooks: "0xA2bdf696822D4D97da31d936c8520d89B9A868c0" as const,
};
const external = {
  address: EXTERNAL,
  fee: 100,
  venue: {
    name: "uniswap-v3",
    factory: "0x204FAca1764B154221e35c0d20aBb3c525710498" as const,
    quoter: "0x661E93cca42AfacB172121EF892830cA3b70F08d" as const,
    fees: [100],
  },
};
const market = {
  chainId: 143,
  poolId: pool.poolId,
  classId: 1n,
  baseToken: USDC,
  amounts: [],
  minNetProfit: 1000n,
  maxInput: 10_000_000n,
  screenGasCost: 4500n,
};
const v4Search = (extra: Record<string, unknown> = {}) =>
  settingsSchema.parse({
    apiUrl: "https://staging-api.aqua0.xyz",
    markets: [],
    discovery: { enabled: true, intervalMs: 120000, maxAgeMs: 600000 },
    v4Search: {
      mode: "quote-grid",
      feedKeys: {
        [USDC.toLowerCase()]: "usd-stable",
        [USDT0.toLowerCase()]: "usd-stable",
        [WETH.toLowerCase()]: "coingecko:ethereum",
      },
      marginBps: 2,
      minBackendIntervalMs: 20000,
      sizesPerScreen: 2,
      ...extra,
    },
  }).v4Search;

/** A fake external pool that pays `bps` above par for USDC and par less 1bp the other way. */
function fakeClient(state: { sqrt: bigint; liquidity: bigint; bps: bigint }) {
  const calls: string[] = [];
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      calls.push(functionName);
      if (functionName === "slot0") return [state.sqrt, 10];
      if (functionName === "liquidity") return state.liquidity;
      if (functionName === "decimals") return 6;
      throw new Error(functionName);
    },
    simulateContract: async ({
      args,
    }: {
      args: [{ tokenIn: string; amountIn: bigint }];
    }) => {
      calls.push("quote");
      const { tokenIn, amountIn } = args[0];
      const out =
        tokenIn.toLowerCase() === USDC.toLowerCase()
          ? (amountIn * (10_000n + state.bps)) / 10_000n
          : (amountIn * 9_999n) / 10_000n;
      return { result: [out, 0n, 0, 0n] };
    },
  } as unknown as PublicClient;
  return { client, calls };
}
const chain = { chainId: 143 } as never;

test("the Aqua0 leg estimate follows the feed ratio, decimals and pool fee", () => {
  assert.equal(
    aquaOutEstimate({
      amountIn: 1_000_000n,
      priceIn: 1,
      priceOut: 1,
      decimalsIn: 6,
      decimalsOut: 6,
      feePips: 100,
    }),
    999_900n,
  );
  assert.equal(
    aquaOutEstimate({
      amountIn: 2_500_000_000n,
      priceIn: 1,
      priceOut: 2500,
      decimalsIn: 6,
      decimalsOut: 18,
      feePips: 3000,
    }),
    997_000_000_000_000_000n,
  );
});

test("a profitable gap passes; an unchanged market is not re-asked after a miss", async () => {
  let now = 0;
  const settings = v4Search();
  const screen = new V4Screen(settings, 1, new FeedPrices(settings), () => now);
  const { client, calls } = fakeClient({
    sqrt: 1n << 96n,
    liquidity: 10n ** 12n,
    bps: 30n,
  });
  const input = {
    client,
    chain,
    pool,
    market,
    external,
    inputCap: 10_000_000n,
    blockNumber: 1n,
  };
  const go = await screen.screen(input);
  assert.equal(go.go, true);
  assert.equal(go.go && go.aquaFirst, false);
  const key = V4Screen.key(143, pool, external);
  screen.noteBackend(key, go.fingerprint!, false);
  now += 60_000;
  const quoted = calls.filter((c) => c === "quote").length;
  const again = await screen.screen(input);
  assert.equal(again.go, false);
  assert.match(again.reason, /not asking again/);
  assert.equal(calls.filter((c) => c === "quote").length, quoted);
});

test("cooldown applies even after a hit, and a moved pool is screened again", async () => {
  let now = 0;
  const settings = v4Search();
  const screen = new V4Screen(settings, 1, new FeedPrices(settings), () => now);
  const state = { sqrt: 1n << 96n, liquidity: 10n ** 12n, bps: 30n };
  const { client } = fakeClient(state);
  const input = {
    client,
    chain,
    pool,
    market,
    external,
    inputCap: 10_000_000n,
    blockNumber: 1n,
  };
  const first = await screen.screen(input);
  screen.noteBackend(
    V4Screen.key(143, pool, external),
    first.fingerprint!,
    true,
  );
  now += 1000;
  assert.match((await screen.screen(input)).reason, /cooldown/);
  now += 30_000;
  state.sqrt += 1n;
  assert.equal((await screen.screen(input)).go, true);
});

test("no gap, an empty external pool and an unpriced pair never reach the backend", async () => {
  const settings = v4Search();
  const screen = new V4Screen(settings, 1);
  const flat = fakeClient({ sqrt: 1n << 96n, liquidity: 10n ** 12n, bps: 0n });
  const input = {
    client: flat.client,
    chain,
    pool,
    market,
    external,
    inputCap: 10_000_000n,
    blockNumber: 1n,
  };
  assert.match((await screen.screen(input)).reason, /no gap/);
  const empty = fakeClient({ sqrt: 1n << 96n, liquidity: 0n, bps: 50n });
  assert.match(
    (await screen.screen({ ...input, client: empty.client })).reason,
    /no active liquidity/,
  );
  const unpriced = new V4Screen(v4Search({ feedKeys: {} }), 1);
  assert.match((await unpriced.screen(input)).reason, /No reviewed feed key/);
});

test("a reported Aqua0 capacity limits later screens to what is backed", async () => {
  const settings = v4Search();
  const screen = new V4Screen(settings, 1);
  const { client } = fakeClient({
    sqrt: 1n << 96n,
    liquidity: 10n ** 12n,
    bps: 30n,
  });
  const input = {
    client,
    chain,
    pool,
    market,
    external,
    inputCap: 10_000_000n,
    blockNumber: 1n,
  };
  const key = V4Screen.key(143, pool, external);
  screen.noteCapacity(key, false, 2_000_000n);
  const result = await screen.screen(input);
  assert.equal(result.go, false);
  assert.match(result.reason, /no gap|No quotable/);
});

test("stale or missing market feed prices refuse the screen", async () => {
  let now = 10_000_000;
  const settings = v4Search();
  const feed = new FeedPrices(
    settings,
    async () => ({
      coins: {
        "coingecko:ethereum": {
          price: 2500,
          timestamp: (now - 600_000) / 1000,
        },
      },
    }),
    () => now,
  );
  const result = await feed.pair(USDC, WETH);
  assert.ok("refused" in result && /stale/.test(result.refused));
  const missing = new FeedPrices(
    settings,
    async () => ({ coins: {} }),
    () => now,
  );
  const none = await missing.pair(USDC, WETH);
  assert.ok("refused" in none);
});

test("a clamped backend quote reports Aqua0's backed amount instead of a fill", () => {
  const raw = {
    quote: {
      amountIn: "1999980",
      amountOut: "1999379",
      amountInToken: USDT0,
      amountOutToken: USDC,
      execution: {
        requestedAmountIn: "8000000",
        authorizedAmountIn: "1999980",
        authorizedAmountOut: "1999379",
        fullySupported: false,
        wasClamped: true,
      },
    },
  };
  assert.throws(
    () => validateQuote(raw, USDT0, USDC, 8_000_000n),
    (e: unknown) => e instanceof AquaCapacityLimit && e.backed === 1_999_980n,
  );
});
