import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { HistoryStore } from "../src/history.js";
import { createReportServer } from "../src/reporting.js";
test("real HTTP loss review requires the separate credential and cannot smuggle trading settings", async () => {
  const history = new HistoryStore(":memory:");
  const token = randomBytes(32).toString("hex"),
    controlToken = randomBytes(32).toString("hex");
  let reviews = 0;
  history.latchEconomics("fork", "net_loss");
  const server = createReportServer({
    network: "fork",
    token,
    controlToken,
    history,
    status: () => ({}),
    health: () => ({ healthy: true, metrics: {} }),
    economicReview: async (input, actor) => {
      reviews++;
      return history.reviewEconomics("fork", input, actor);
    },
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const snapshot = history.economics("fork");
  const body = {
    network: "fork",
    actor: "admin",
    change: {
      expectedVersion: snapshot.version,
      throughSettlement: snapshot.throughSettlement,
      reason: "Deliberately latched test-only pause",
      acknowledgeLosses: true,
    },
  };
  const post = (credential: string, value: unknown) =>
    fetch(`${origin}/v1/economics/review`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(value),
    });
  try {
    assert.equal((await post(token, body)).status, 401);
    assert.equal(reviews, 0);
    assert.equal(
      (await post(controlToken, { ...body, network: "mainnet" })).status,
      400,
    );
    assert.equal(
      (
        await post(controlToken, {
          ...body,
          change: { ...body.change, allowBroadcast: true },
        })
      ).status,
      400,
    );
    assert.equal(reviews, 0);
    const response = await post(controlToken, body);
    assert.equal(response.status, 200);
    const saved = (await response.json()) as {
      state: { blocked: boolean };
      tradingPermissionsChanged: boolean;
    };
    assert.equal(saved.state.blocked, false);
    assert.equal(saved.tradingPermissionsChanged, false);
    assert.equal(reviews, 1);
    assert.equal((await post(controlToken, body)).status, 409);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    history.close();
  }
});
