import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicClient } from "viem";
import { loadChains, settingsSchema } from "../src/config.js";
import { MarketCatalog } from "../src/market-catalog.js";
import { Runner } from "../src/runner.js";
import { Journal } from "../src/state.js";
import type { AquaClient } from "../src/aqua.js";

const chain = loadChains().find((c) => c.chainId === 42161)!;
const id = "0x1f7d6bb891093beb90fb3802388282e1d2fea68118c3220d902c7a8e207b5f15";
const usdc = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const listing = () => ({
  chainId: 42161,
  rpcDegraded: false,
  pools: [
    {
      poolId: id,
      currency0: usdc,
      currency1: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      fee: 100,
      tickSpacing: 1,
      hooks: chain.aqua0Hook,
      poolManager: chain.poolManager,
      isAqua0Enabled: true,
      armedOnCurrentAdapter: true,
      sqrtPriceX96: "79228162514264337593543950336000000",
      aquaClass: { classId: "10", paused: false, otherClassIds: ["12"] },
      token0: { symbol: "USDC", decimals: 6 },
      token1: { symbol: "DAI", decimals: 18 },
    },
  ],
});

for (const state of ["unapproved", "degraded", "absent"] as const) {
  test(`V4 ${state} USDC/DAI is idle, not a completed price search`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "v4-idle-"));
    const catalog = new MarketCatalog(":memory:", "mainnet", [chain]);
    const settings = settingsSchema.parse({
      apiUrl: "https://example.invalid",
      mode: "observe",
      discovery: { enabled: true },
    });
    let priceCalls = 0;
    const aqua = {
      searchStatus: () => ({
        active: 0,
        queued: 0,
        limit: 4,
        perChainLimit: 2,
        selectedTradeChecksQueued: 0,
      }),
      optimize: async () => {
        priceCalls++;
        throw new Error("An ineligible market must never be priced");
      },
    } as unknown as AquaClient;
    const client = {
      getChainId: async () => 42161,
      getCode: async () => "0x1234",
      readContract: async ({ functionName }: { functionName: string }) => {
        assert.equal(functionName, "poolManager");
        return chain.poolManager;
      },
    } as unknown as PublicClient;
    class OfflineRunner extends Runner {
      override client() {
        return client;
      }
    }
    const runner = new OfflineRunner(
      [chain],
      settings,
      aqua,
      new Journal(join(dir, "journal.json")),
      undefined,
      catalog,
    );
    try {
      catalog.recordListing(chain, listing());
      if (state !== "unapproved") {
        catalog.setPolicy(
          42161,
          id,
          {
            expectedVersion: 0,
            approved: true,
            classId: "10",
            baseToken: usdc,
            amounts: [],
            maxInput: "5000000",
            minNetProfit: "10000",
            note: "Local-only test policy",
          },
          "unit-test",
        );
        if (state === "degraded")
          catalog.recordFailure(42161, "Test-only unavailable discovery");
        else
          catalog.recordListing(chain, {
            chainId: 42161,
            rpcDegraded: false,
            pools: [],
          });
      }
      const policyBefore = catalog.list().markets[0]!.policy;
      assert.equal(await runner.scanLatest(42161), false);
      assert.equal(runner.metrics.lastSuccess, 0);
      assert.ok(
        runner.metrics.lastHeartbeat > 0,
        "An idle process is still alive",
      );
      assert.equal(runner.metrics.errors, 0);
      assert.equal(priceCalls, 0);
      const status = runner.reportingStatus();
      assert.equal(status.chains[0]!.configuredMarkets, 0);
      assert.equal(status.chains[0]!.lastScan, null);
      assert.equal(
        status.chains[0]!.activity!.stage,
        "Waiting for an eligible approved market",
      );
      assert.deepEqual(
        catalog.list().markets[0]!.policy,
        policyBefore,
        "Idle handling must not alter approvals",
      );
      assert.equal(
        await runner.scanLatest(42161),
        false,
        "The chain lock must be released",
      );
      assert.equal(priceCalls, 0);
    } finally {
      catalog.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// A known Aqua-bound class must never be supplied as a guessed V4 policy.
test("USDC/DAI readiness record cannot activate the withdrawn class-10 route", () => {
  const draft = JSON.parse(
    readFileSync("config/arbitrum-usdc-dai-readiness.json", "utf8"),
  );
  const catalog = new MarketCatalog(":memory:", "mainnet", [chain]);
  try {
    catalog.recordListing(chain, listing());
    assert.equal(draft.approved, false);
    assert.equal(draft.classId, null);
    assert.equal(draft.withdrawnClassId, "10");
    assert.equal(draft.status, "blocked-missing-v4-class");
    assert.throws(() =>
      catalog.setPolicy(42161, id, draft, "local-readiness-validation"),
    );
    assert.equal(catalog.activeMarkets().length, 0);
    assert.equal(catalog.list().markets[0]!.policy, null);
  } finally {
    catalog.close();
  }
});
