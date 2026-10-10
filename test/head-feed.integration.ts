import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, http, type PublicClient } from "viem";
import { startHeadFeed } from "../src/head-feed.js";
import { LatestHeadScheduler } from "../src/head-scheduler.js";
async function port() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const p = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return p;
}
async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end)
      throw Error("Condition was not observed before timeout");
    await sleep(20);
  }
}
for (const useSocket of [true, false])
  test(`real local blocks trigger isolated scans through ${useSocket ? "WebSocket pushes" : "HTTP header fallback"}`, async () => {
    const p = await port(),
      url = `http://127.0.0.1:${p}`;
    const child = spawn(
      "anvil",
      ["--host", "127.0.0.1", "--port", String(p), "--silent", "--no-mining"],
      { stdio: "ignore" },
    );
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });
    let startupError: Error | undefined;
    child.on("error", (e) => {
      startupError = e;
    });
    const client = createPublicClient({
      cacheTime: 0,
      transport: http(url, { timeout: 500, retryCount: 0 }),
    });
    let feed: ReturnType<typeof startHeadFeed> | undefined;
    const scans: bigint[] = [];
    const scheduler = new LatestHeadScheduler({
      maxConcurrent: 2,
      maxBlockLag: 2,
      maxTaskMs: 3000,
      run: async (_, t) => {
        t.assertCurrent();
        scans.push(t.head.number);
      },
    });
    try {
      let ready = false;
      for (let i = 0; i < 80 && !ready; i++) {
        if (startupError) throw startupError;
        if (exited) throw Error("Anvil exited");
        try {
          ready = (await client.getChainId()) === 31337;
        } catch {
          await sleep(25);
        }
      }
      assert(ready, "local Anvil readiness");
      feed = startHeadFeed({
        chainId: 31337,
        client,
        ...(useSocket ? { websocketUrl: `ws://127.0.0.1:${p}` } : {}),
        pollMs: 100,
        auditMs: 1000,
        onHead: (h) => scheduler.notify(31337, h),
        onError: () => {},
      });
      await until(() => scans.length > 0);
      for (let i = 0; i < 6; i++) {
        await client.request({
          method: "anvil_mine" as never,
          params: ["0x1"] as never,
        });
        await sleep(80);
      }
      await until(() => scans.includes(6n));
      const count = scans.length;
      await sleep(250);
      assert.equal(
        scans.length,
        count,
        "unchanged block must not cause duplicate scans",
      );
      if (useSocket)
        assert(
          feed.status().websocketHeaders > 0,
          "at least one actual subscription notification",
        );
      else assert(feed.status().httpChecks > 0);
      assert(
        scheduler.status()[0]!.lastStartDelayMs < 100,
        "local header-to-handler scheduling does not impose a polling sleep",
      );
    } finally {
      await feed?.stop();
      await scheduler.stop();
      child.kill("SIGTERM");
      await until(() => exited, 3000);
    }
  });

test("an HTTP response started before newer WebSocket headers cannot rewind the work queue", async () => {
  const p = await port(),
    url = `http://127.0.0.1:${p}`;
  const child = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(p), "--silent", "--no-mining"],
    { stdio: "ignore" },
  );
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const client = createPublicClient({
    cacheTime: 0,
    transport: http(url, { timeout: 500, retryCount: 0 }),
  });
  let feed: ReturnType<typeof startHeadFeed> | undefined;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const observed: bigint[] = [];
  try {
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      try {
        ready = (await client.getChainId()) === 31337;
      } catch {
        await sleep(25);
      }
    }
    assert(ready);
    const old = await client.getBlock();
    let first = true;
    const delayed = {
      ...client,
      getBlock: async (...args: Parameters<typeof client.getBlock>) => {
        if (first) {
          first = false;
          await held;
          return old;
        }
        return client.getBlock(...args);
      },
    };
    feed = startHeadFeed({
      chainId: 31337,
      client: delayed as unknown as PublicClient,
      websocketUrl: `ws://127.0.0.1:${p}`,
      pollMs: 100,
      auditMs: 1000,
      onHead: (h) => observed.push(h.number),
      onError: () => {},
    });
    await sleep(100);
    for (let i = 0; i < 3; i++) {
      await client.request({
        method: "anvil_mine" as never,
        params: ["0x1"] as never,
      });
      await sleep(80);
    }
    await until(() => observed.includes(3n));
    release();
    await sleep(150);
    assert.equal(observed[observed.length - 1], 3n);
    assert(!observed.slice(observed.indexOf(3n) + 1).some((n) => n < 3n));
  } finally {
    release?.();
    await feed?.stop();
    child.kill("SIGTERM");
    await until(() => exited, 3000);
  }
});
