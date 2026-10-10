import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import { loadChains } from "../src/config.js";
import { MarketCatalog, validatePoolListing } from "../src/market-catalog.js";
const chain = loadChains().find((c) => c.chainId === 8453)!;
const token0 = "0x0000000000000000000000000000000000000011" as const;
const token1 = "0x0000000000000000000000000000000000000022" as const;
const key = {
  currency0: token0,
  currency1: token1,
  fee: 3000,
  tickSpacing: 60,
  hooks: chain.aqua0Hook,
};
const id = keccak256(
  encodeAbiParameters(
    parseAbiParameters("address,address,uint24,int24,address"),
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  ),
);
const listing = () => ({
  chainId: 8453,
  rpcDegraded: false,
  pools: [
    {
      ...key,
      poolId: id,
      poolManager: chain.poolManager,
      isAqua0Enabled: true,
      armedOnCurrentAdapter: true,
      sqrtPriceX96: "79228162514264337593543950336",
      currentTick: 0,
      aquaClass: { classId: "7", otherClassIds: [] },
      token0: { symbol: "A", decimals: 6 },
      token1: { symbol: "B", decimals: 18 },
    },
  ],
});
const approved = {
  expectedVersion: 0,
  approved: true,
  classId: "7",
  baseToken: token0,
  amounts: ["1000000", "2000000"],
  maxInput: "2000000",
  minNetProfit: "1000",
  note: "Review fixture",
};

test("a new public pair appears unapproved, persists on restart, and never grants execution itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "market-catalog-")),
    file = join(dir, "catalog.sqlite");
  let now = 1000000;
  try {
    let db = new MarketCatalog(file, "mainnet", [chain], () => now);
    db.recordListing(chain, listing());
    assert.equal(db.list().markets.length, 1);
    assert.equal(db.list().markets[0]!.policy, null);
    assert.equal(db.activeMarkets().length, 0);
    const policy = db.setPolicy(8453, id, approved, "verified-admin");
    assert.equal(policy.version, 1);
    assert.equal(db.activeMarkets()[0]!.classId, 7n);
    assert.equal(db.list().executionActivationSupported, false);
    db.close();
    db = new MarketCatalog(file, "mainnet", [chain], () => now);
    assert.equal(db.list().markets[0]!.policy?.version, 1);
    assert.throws(
      () => db.setPolicy(8453, id, approved, "verified-admin"),
      /version/i,
    );
    db.setPolicy(
      8453,
      id,
      { ...approved, approved: false, expectedVersion: 1 },
      "verified-admin",
    );
    assert.equal(db.activeMarkets().length, 0);
    assert.equal(db.audit(8453, id).length, 2);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("bad public identity or partial reads do not produce approved executable liquidity", () => {
  const db = new MarketCatalog(":memory:", "mainnet", [chain]);
  try {
    for (const invalid of [
      { ...listing(), chainId: 1 },
      { ...listing(), rpcDegraded: true },
      {
        ...listing(),
        pools: [{ ...listing().pools[0], poolId: `0x${"01".repeat(32)}` }],
      },
    ])
      assert.throws(() => validatePoolListing(chain, invalid));
    db.recordListing(chain, listing());
    db.setPolicy(8453, id, approved, "admin");
    db.recordFailure(8453, "Public listing unavailable");
    assert.equal(db.list().markets.length, 1);
    assert.equal(db.activeMarkets().length, 0);
    assert.equal(
      db.list().markets[0]!.policy?.approved,
      true,
      "read failure preserves saved policy without treating it as usable",
    );
    db.recordListing(chain, listing());
    assert.equal(db.activeMarkets().length, 1);
    db.recordListing(chain, { ...listing(), pools: [] });
    assert.equal(db.activeMarkets().length, 0);
    assert.equal(db.list().markets[0]!.present, false);
  } finally {
    db.close();
  }
});
test("stale listings, unknown classes, wrong assets and excess sample sizes fail before trade selection", () => {
  let now = 1000000;
  const db = new MarketCatalog(":memory:", "fork", [chain], () => now);
  try {
    db.recordListing(chain, listing());
    assert.throws(
      () => db.setPolicy(8453, id, { ...approved, classId: "8" }, "admin"),
      /class/i,
    );
    assert.throws(
      () =>
        db.setPolicy(
          8453,
          id,
          { ...approved, baseToken: chain.aqua0Hook },
          "admin",
        ),
      /asset/i,
    );
    assert.throws(
      () => db.setPolicy(8453, id, { ...approved, maxInput: "1" }, "admin"),
      /size/i,
    );
    db.setPolicy(8453, id, approved, "admin");
    now += 601000;
    assert.equal(db.activeMarkets().length, 0);
    assert.match(db.list().markets[0]!.blockers.join(" "), /stale/i);
    assert.throws(
      () =>
        db.setPolicy(8453, id, { ...approved, expectedVersion: 1 }, "admin"),
      /stale/i,
    );
    db.setPolicy(
      8453,
      id,
      { ...approved, approved: false, expectedVersion: 1 },
      "admin",
    );
  } finally {
    db.close();
  }
});
