import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { HistoryStore } from "../src/history.js";
import { ObservationStore } from "../src/observations.js";
import { createReportServer } from "../src/reporting.js";

const wallet = `0x${"11".repeat(20)}`;
const hash = `0x${"22".repeat(32)}`;
const stamp = "2026-10-01T08:00:00.000Z";

test("new history endpoints are authenticated GET-only, network-scoped and never expose a false empty result", async () => {
  const history = new HistoryStore(":memory:");
  const observations = new ObservationStore(":memory:");
  observations.begin("mainnet");
  const row = {
    network: "mainnet",
    chainId: 42161,
    role: "executor",
    wallet,
    asset: null,
    symbol: "ETH",
    decimals: 18,
    amount: "0",
    blockNumber: "1",
    blockHash: hash,
    blockTimestamp: stamp,
    observedAt: stamp,
    source: "periodic",
    issue: null,
  };
  observations.balance(row);
  observations.balance({ ...row, network: "fork", amount: "999" });
  const token = randomBytes(32).toString("hex");
  const controlToken = randomBytes(32).toString("hex");
  const server = createReportServer({
    network: "mainnet",
    token,
    controlToken,
    history,
    observations,
    status: () => ({}),
    health: () => ({ healthy: true, metrics: {} }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: `Bearer ${token}` };
  try {
    for (const path of ["/v1/opportunities", "/v1/balances"]) {
      assert.equal((await fetch(origin + path)).status, 401);
      assert.equal(
        (
          await fetch(origin + path, {
            headers: { authorization: `Bearer ${controlToken}` },
          })
        ).status,
        401,
      );
      assert.equal(
        (await fetch(origin + path, { headers, method: "POST" })).status,
        405,
      );
      const r = await fetch(origin + path, { headers });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("cache-control"), "no-store");
      const body = (await r.json()) as { items: unknown[]; network: string };
      assert.equal(body.network, "mainnet");
      assert(!JSON.stringify(body).includes("999"));
      assert(!JSON.stringify(body).includes(token));
      for (const q of ["network=fork", "limit=501", "cursor=bad", "unknown=1"])
        assert.equal(
          (await fetch(`${origin}${path}?${q}`, { headers })).status,
          400,
        );
    }
    assert.equal(
      (await fetch(`${origin}/v1/opportunities?role=executor`, { headers }))
        .status,
      400,
    );
    assert.equal(
      (await fetch(`${origin}/v1/balances?state=submitted`, { headers }))
        .status,
      400,
    );
    observations.close();
    assert.equal(
      (await fetch(`${origin}/v1/balances`, { headers })).status,
      503,
    );
    assert.equal(
      (await fetch(`${origin}/v1/executions`, { headers })).status,
      200,
      "Separate transaction accounting must remain available",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      observations.close();
    } catch {
      /* Deliberately closed above. */
    }
    history.close();
  }
});

test("disabled observation history returns unavailable, not a fabricated empty history", async () => {
  const history = new HistoryStore(":memory:");
  const token = randomBytes(32).toString("hex");
  const server = createReportServer({
    network: "fork",
    token,
    history,
    status: () => ({}),
    health: () => ({ healthy: true, metrics: {} }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const route of ["opportunities", "balances"])
      assert.equal(
        (
          await fetch(`${origin}/v1/${route}`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
        503,
      );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    history.close();
  }
});
