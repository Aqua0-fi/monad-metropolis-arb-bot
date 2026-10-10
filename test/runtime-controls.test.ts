import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeControls } from "../src/runtime-controls.js";
test("global and chain pauses survive restart, retain other permissions, and reject stale saves", () => {
  const path = mkdtempSync(join(tmpdir(), "runtime-controls-"));
  let c = new RuntimeControls(
    join(path, "controls.sqlite"),
    "fork",
    [8453, 42161],
  );
  try {
    assert.equal(c.paused(8453), false);
    c.change(
      { expectedVersion: 0, scope: "chain", chainId: 8453, paused: true },
      "admin",
    );
    assert.equal(c.paused(8453), true);
    assert.equal(c.paused(42161), false);
    c.change({ expectedVersion: 1, scope: "all", paused: true }, "admin");
    assert.equal(c.paused(42161), true);
    c.close();
    c = new RuntimeControls(
      join(path, "controls.sqlite"),
      "fork",
      [8453, 42161],
    );
    assert.equal(c.paused(42161), true);
    assert.throws(
      () =>
        c.change({ expectedVersion: 1, scope: "all", paused: false }, "admin"),
      /changed|conflict/,
    );
    c.change({ expectedVersion: 2, scope: "all", paused: false }, "admin");
    assert.equal(c.paused(8453), true);
    assert.equal(c.paused(42161), false);
    const mainnet = new RuntimeControls(
      join(path, "controls.sqlite"),
      "mainnet",
      [8453],
    );
    try {
      assert.equal(mainnet.paused(8453), false);
    } finally {
      mainnet.close();
    }
    assert.throws(() =>
      c.change(
        { expectedVersion: 3, scope: "chain", chainId: 10, paused: true },
        "admin",
      ),
    );
    assert.throws(() =>
      c.change(
        {
          expectedVersion: 3,
          scope: "all",
          paused: false,
          allowBroadcast: true,
        },
        "admin",
      ),
    );
    assert.equal(c.read().version, 3);
  } finally {
    c.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test("actual control HTTP endpoint requires its separate credential and cannot change execution permissions", async () => {
  const { createReportServer } = await import("../src/reporting.js"),
    { HistoryStore } = await import("../src/history.js"),
    { randomBytes } = await import("node:crypto");
  const controls = new RuntimeControls(":memory:", "fork", [8453]),
    history = new HistoryStore(":memory:");
  const read = randomBytes(32).toString("hex"),
    write = randomBytes(32).toString("hex");
  let changed = 0;
  const server = createReportServer({
    network: "fork",
    token: read,
    controlToken: write,
    controls,
    history,
    status: () => ({ operatingControl: controls.read() }),
    health: () => ({ healthy: true, metrics: {} }),
    onPolicyChanged: () => {
      changed++;
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (token: string, body: unknown) =>
    fetch(url + "/v1/runtime", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const input = {
    network: "fork",
    actor: "verified-admin",
    change: { expectedVersion: 0, scope: "all", paused: true },
  };
  try {
    assert.equal((await post(read, input)).status, 401);
    assert.equal(controls.read().version, 0);
    assert.equal(
      (await post(write, { ...input, network: "mainnet" })).status,
      400,
    );
    assert.equal(
      (
        await post(write, {
          ...input,
          change: { ...input.change, allowBroadcast: true },
        })
      ).status,
      400,
    );
    const saved = await post(write, input);
    assert.equal(saved.status, 200);
    assert.equal(
      ((await saved.json()) as { tradingPermissionsChanged: boolean })
        .tradingPermissionsChanged,
      false,
    );
    assert.equal(changed, 1);
    assert.equal(controls.paused(8453), true);
    assert.equal((await post(write, input)).status, 409);
    const status = await fetch(url + "/v1/status", {
      headers: { authorization: `Bearer ${read}` },
    });
    assert.equal(status.status, 200);
    assert.equal(
      ((await status.json()) as { operatingControl: { paused: boolean } })
        .operatingControl.paused,
      true,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    controls.close();
    history.close();
  }
});
