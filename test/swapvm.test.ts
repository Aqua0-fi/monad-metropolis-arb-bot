import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadChains } from "../src/config.js";
import {
  acceptSwapVMOptimization,
  validateSwapVMListing,
  type SwapVMSizingRequest,
} from "../src/swapvm.js";
import { SwapVMMarketCatalog } from "../src/swapvm-catalog.js";
import { MarketCatalog } from "../src/market-catalog.js";
const a = (n: number) =>
  `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const h = (n: number) =>
  `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const chain = {
  ...loadChains().find((c) => c.chainId === 8453)!,
  swapVM: { router: a(9), maker: a(8), aqua: a(10), slices: 10 as const },
};
const order = { maker: a(8), traits: 1n << 254n, data: "0x1100" as const };
const currentAquaHash = keccak256(
  encodeAbiParameters(
    parseAbiParameters("(address maker,uint256 traits,bytes data)"),
    [order],
  ),
);
const descriptor = {
  venue: "aqua",
  chainId: 8453,
  stableStrategyId: h(99),
  classId: "7",
  currentAquaHash,
  router: a(9),
  maker: a(8),
  aqua: a(10),
  slices: 10,
  token0: a(1),
  token1: a(2),
  tokens: [
    { address: a(1), symbol: "T0", decimals: 6 },
    { address: a(2), symbol: "T1", decimals: 18 },
  ],
  order: { ...order, traits: order.traits.toString() },
  blockNumber: "100",
  blockHash: h(100),
  available: true,
};
const listing = (value = descriptor) => ({
  version: 1,
  venue: "aqua",
  network: "fork",
  chainId: 8453,
  markets: [value],
  unavailable: [],
});
const policy = {
  approved: true,
  classId: "7",
  baseToken: a(1),
  amounts: [],
  maxInput: "1000",
  minNetProfit: "2",
  note: "",
  expectedVersion: 0,
};

test("SwapVM catalog is restart-durable and approvals cannot leak from V4 or another network", () => {
  const directory = mkdtempSync(join(tmpdir(), "aqua-catalog-"));
  let catalog = new SwapVMMarketCatalog(
    join(directory, "aqua.sqlite"),
    "fork",
    [chain],
  );
  const v4 = new MarketCatalog(":memory:", "fork", [chain]);
  try {
    catalog.recordListing(chain, listing());
    assert.equal(catalog.list().markets[0]!.readyToQuote, false);
    assert.throws(() =>
      catalog.setPolicy(8453, h(99), { ...policy, classId: "8" }, "owner"),
    );
    catalog.setPolicy(8453, h(99), policy, "owner");
    assert.equal(catalog.list().markets[0]!.readyToQuote, true);
    assert.equal(v4.list().markets.length, 0);
    catalog.close();
    catalog = new SwapVMMarketCatalog(join(directory, "aqua.sqlite"), "fork", [
      chain,
    ]);
    assert.equal(catalog.list().markets[0]!.policy?.version, 1);
    assert.throws(
      () => catalog.setPolicy(8453, h(99), policy, "owner"),
      /version conflict/,
    );
    const mainnet = new SwapVMMarketCatalog(
      join(directory, "aqua.sqlite"),
      "mainnet",
      [chain],
    );
    try {
      assert.equal(mainnet.list().markets.length, 0);
    } finally {
      mainnet.close();
    }
    catalog.recordFailure(8453);
    assert.equal(catalog.list().markets[0]!.readyToQuote, false);
    catalog.setPolicy(
      8453,
      h(99),
      { ...policy, approved: false, expectedVersion: 1 },
      "owner",
    );
    assert.equal(catalog.list().markets[0]!.policy?.approved, false);
  } finally {
    catalog.close();
    v4.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bad current order hashes and duplicate stable identities cannot poison discovery", () => {
  assert.throws(() =>
    validateSwapVMListing(
      chain,
      "fork",
      listing({ ...descriptor, currentAquaHash: h(42) }),
    ),
  );
  assert.throws(() => validateSwapVMListing(chain, "mainnet", listing()));
  assert.throws(() =>
    validateSwapVMListing(chain, "fork", {
      ...listing(),
      markets: [descriptor, descriptor],
    }),
  );
});

test("discovery is bound to the canonical router, maker, Aqua and header layout", () => {
  for (const changes of [{ router: a(42) }, { aqua: a(42) }, { slices: 9 }]) {
    assert.throws(() =>
      validateSwapVMListing(
        chain,
        "fork",
        listing({ ...descriptor, ...changes }),
      ),
    );
  }
  assert.throws(() =>
    validateSwapVMListing({ ...chain, swapVM: undefined }, "fork", listing()),
  );
});

test("opaque search results bind caller, current order and risk math to a distinct venue-2 leg", () => {
  const market = validateSwapVMListing(chain, "fork", listing()).markets[0]!;
  const external = { address: a(20), fee: 500, venue: chain.venues[0]! };
  const request: SwapVMSizingRequest = {
    chain,
    market,
    policy: {
      ...policy,
      actor: "owner",
      version: 1,
      updatedAt: new Date().toISOString(),
    },
    external,
    caller: a(30),
    network: "fork",
    maxInput: 1000n,
    gasBudget: 10n,
    slippageBps: 10,
  };
  const raw = {
    version: 1,
    venue: "aqua",
    network: "fork",
    chainId: 8453,
    market: descriptor,
    caller: request.caller,
    baseToken: a(1),
    externalPool: external.address,
    externalFactory: external.venue.factory,
    externalFee: 500,
    maxInput: "1000",
    minNetProfit: "2",
    gasBudget: "10",
    blockNumber: "100",
    blockHash: h(100),
    blockTimestamp: "1000",
    quoteKind: "actual-swapvm-and-native-v3",
    transactionSimulated: false,
    reservationsCreated: false,
    candidates: [
      {
        aquaFirst: true,
        amountIn: "73",
        firstAmountOut: "150",
        secondAmountIn: "149",
        finalAmountOut: "86",
        grossProfit: "13",
        netProfit: "3",
      },
    ],
    searches: [],
  };
  const candidate = acceptSwapVMOptimization(raw, request, 12).candidates[0]!;
  assert.equal(candidate.trade.first.venue, 2);
  assert.equal(candidate.trade.second.venue, 1);
  assert.equal(candidate.swapVM?.stableStrategyId, h(99));
  assert.equal(candidate.trade.first.pool.fee, 0);
  assert.equal(candidate.trade.minProfit, 12n);
  assert.equal(candidate.trade.first.amountIn, 73n);
  for (const changed of [
    { caller: a(31) },
    { gasBudget: "1" },
    { externalPool: a(32) },
    { blockHash: h(101) },
    { blockNumber: "101" },
  ]) {
    assert.throws(() =>
      acceptSwapVMOptimization({ ...raw, ...changed }, request, 12),
    );
  }
  assert.throws(() =>
    acceptSwapVMOptimization(raw, { ...request, fixedAmount: 74n }, 12),
  );
});

test("real reporter serializes SwapVM integer fields and keeps the report credential read-only", async () => {
  const { createReportServer } = await import("../src/reporting.js");
  const { HistoryStore } = await import("../src/history.js");
  const { randomBytes } = await import("node:crypto");
  const history = new HistoryStore(":memory:");
  const catalog = new SwapVMMarketCatalog(":memory:", "fork", [chain]);
  catalog.recordListing(chain, listing());
  const token = randomBytes(32).toString("hex");
  const server = createReportServer({
    network: "fork",
    token,
    history,
    swapVMCatalog: catalog,
    status: () => ({}),
    health: () => ({ healthy: true, metrics: {} }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${origin}/v1/aqua-markets`)).status, 401);
    const response = await fetch(`${origin}/v1/aqua-markets`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200);
    const data = (await response.json()) as {
      markets: {
        market: {
          classId: string;
          blockNumber: string;
          order: { traits: string };
        };
      }[];
    };
    assert.equal(data.markets[0]!.market.classId, "7");
    assert.equal(data.markets[0]!.market.blockNumber, "100");
    assert.equal(data.markets[0]!.market.order.traits, (1n << 254n).toString());
    assert.equal(
      (
        await fetch(`${origin}/v1/aqua-markets/8453/${h(99)}/policy`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ network: "fork", actor: "owner", policy }),
        })
      ).status,
      401,
    );
    assert.equal(catalog.list().markets[0]!.policy, null);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    catalog.close();
    history.close();
  }
});
