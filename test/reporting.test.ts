import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { HistoryStore, type ExecutionRecord } from "../src/history.js";
import { createReportServer } from "../src/reporting.js";
const a = `0x${"01".repeat(20)}`;
const h = `0x${"02".repeat(32)}`;
const record: ExecutionRecord = {
  version: 1,
  network: "fork",
  chainId: 8453,
  transactionHash: h,
  tradeId: h,
  executor: a,
  operator: a,
  poolId: h,
  aqua0Hook: a,
  tokenIn: a,
  tokenOut: a,
  amountIn: "100",
  minimumProfit: "1",
  quotedNetProfit: "2",
  aquaFirst: true,
  preparedAt: "2026-09-24T00:00:00.000Z",
  status: "pending",
  broadcastAcknowledged: false,
  receipt: null,
};

test("real read-only HTTP reporting enforces its own credential and chain/network filters", async () => {
  const history = new HistoryStore(":memory:");
  history.prepare(record);
  const token = randomBytes(32).toString("hex");
  const server = createReportServer({
    network: "fork",
    token,
    history,
    status: () => ({ service: "market-rebalancer-service" }),
    health: () => ({ healthy: true, metrics: { scans: 1 } }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: `Bearer ${token}` };
  try {
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    assert.equal((await fetch(`${origin}/v1/executions`)).status, 401);
    assert.equal(
      (
        await fetch(`${origin}/v1/executions`, {
          headers: { authorization: "Bearer wrong" },
        })
      ).status,
      401,
    );
    const response = await fetch(`${origin}/v1/executions?chainId=8453`, {
      headers,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const page = (await response.json()) as {
      items: ExecutionRecord[];
      matchedCount: number;
    };
    assert.equal(page.items[0]?.transactionHash, h);
    assert.equal(page.matchedCount, 1);
    assert(!JSON.stringify(page).includes(token));
    assert.equal(
      (await fetch(`${origin}/v1/executions?network=mainnet`, { headers }))
        .status,
      400,
    );
    assert.equal(
      (await fetch(`${origin}/v1/executions?limit=101`, { headers })).status,
      400,
    );
    assert.equal(
      (await fetch(`${origin}/v1/executions?cursor=invalid`, { headers }))
        .status,
      400,
    );
    assert.equal(
      (await fetch(`${origin}/v1/executions?cursor=bnVsbA`, { headers }))
        .status,
      400,
    );
    assert.equal(
      (await fetch(`${origin}/v1/executions`, { method: "POST", headers }))
        .status,
      405,
    );
    assert.equal(
      (await fetch(`${origin}/v1/executions/42161/${h}`, { headers })).status,
      404,
    );
    assert.equal(
      (await fetch(`${origin}/v1/executions/8453/${h}`, { headers })).status,
      200,
    );
    history.close();
    assert.equal(
      (await fetch(`${origin}/v1/executions`, { headers })).status,
      503,
      "an unavailable database is not an empty page",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      history.close();
    } catch {
      /* Already closed deliberately above. */
    }
  }
});

test("reporting has no default credential and refuses short explicitly supplied tokens", async () => {
  const history = new HistoryStore(":memory:");
  assert.throws(() =>
    createReportServer({
      network: "fork",
      token: "short",
      history,
      status: () => ({}),
      health: () => ({ healthy: true, metrics: {} }),
    }),
  );
  const server = createReportServer({
    network: "fork",
    history,
    status: () => ({}),
    health: () => ({ healthy: true, metrics: {} }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/status`,
          { headers: { authorization: "Bearer anything" } },
        )
      ).status,
      401,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    history.close();
  }
});
