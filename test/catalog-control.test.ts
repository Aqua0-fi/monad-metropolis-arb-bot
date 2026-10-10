import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import { MarketCatalog } from "../src/market-catalog.js";
import { HistoryStore } from "../src/history.js";
import { createReportServer } from "../src/reporting.js";
import { loadChains } from "../src/config.js";
const chain = loadChains().find((c) => c.chainId === 8453)!;
const pool = chain.pools[0]!;
const id = keccak256(
  encodeAbiParameters(
    parseAbiParameters("address,address,uint24,int24,address"),
    [pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks],
  ),
);

test("public reporting credential cannot approve pairs and control changes are network/version scoped", async () => {
  const catalog = new MarketCatalog(":memory:", "fork", [chain]),
    history = new HistoryStore(":memory:");
  catalog.recordListing(chain, {
    chainId: chain.chainId,
    rpcDegraded: false,
    pools: [
      {
        ...pool,
        poolId: id,
        poolManager: chain.poolManager,
        armedOnCurrentAdapter: true,
        sqrtPriceX96: "79228162514264337593543950336",
        aquaClass: { classId: "1" },
      },
    ],
  });
  const read = randomBytes(32).toString("hex"),
    control = randomBytes(32).toString("hex");
  const server = createReportServer({
    network: "fork",
    token: read,
    controlToken: control,
    catalog,
    history,
    status: () => ({}),
    health: () => ({ healthy: true, metrics: {} }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  const policy = {
    expectedVersion: 0,
    approved: true,
    classId: "1",
    baseToken: pool.currency0,
    amounts: ["100"],
    maxInput: "100",
    minNetProfit: "1",
    note: "Controlled test",
  };
  const write = (token: string, body: unknown) =>
    fetch(`${root}/v1/markets/${chain.chainId}/${id}/policy`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(`${root}/v1/markets`)).status, 401);
    assert.equal(
      (
        await fetch(`${root}/v1/markets`, {
          headers: { authorization: `Bearer ${read}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (await write(read, { network: "fork", actor: "admin", policy })).status,
      401,
    );
    assert.equal(catalog.activeMarkets().length, 0);
    assert.equal(
      (await write(control, { network: "mainnet", actor: "admin", policy }))
        .status,
      400,
    );
    assert.equal(
      (await write(control, { network: "fork", actor: "admin", policy }))
        .status,
      200,
    );
    assert.equal(catalog.activeMarkets().length, 1);
    assert.equal(
      (await write(control, { network: "fork", actor: "admin", policy }))
        .status,
      409,
    );
    assert.equal(catalog.audit(chain.chainId, id).length, 1);
    assert.equal(
      (
        await fetch(`${root}/v1/execute`, {
          method: "POST",
          headers: { authorization: `Bearer ${control}` },
        })
      ).status,
      405,
    );
    assert.equal(catalog.list().executionActivationSupported, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    catalog.close();
    history.close();
  }
});
test("report/control secrets must be distinct and neither has an implicit default", () => {
  const history = new HistoryStore(":memory:");
  try {
    const same = randomBytes(32).toString("hex");
    assert.throws(
      () =>
        createReportServer({
          network: "mainnet",
          token: same,
          controlToken: same,
          history,
          status: () => ({}),
          health: () => ({ healthy: true, metrics: {} }),
        }),
      /distinct/i,
    );
  } finally {
    history.close();
  }
});
