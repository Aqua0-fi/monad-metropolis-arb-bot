import test from "node:test";
import assert from "node:assert/strict";
import type { PublicClient, Hex } from "viem";
import { waitForRpcHead } from "../src/rpc-head.js";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
function harness(numbers: bigint[]) {
  let at = 0,
    now = 1000;
  const client = {
    getBlock: async () => {
      const number = numbers[Math.min(at++, numbers.length - 1)]!;
      return { number, hash: hash(Number(number)), timestamp: 1n };
    },
  } as unknown as PublicClient;
  return {
    client,
    reads: () => at,
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

test("a fresh quote ahead of a lagging latest RPC waits for that provider to catch up", async () => {
  const h = harness([100n, 101n, 102n]);
  const head = await waitForRpcHead(h.client, 102n, 2000, {
    pollMs: 100,
    now: h.now,
    sleep: h.sleep,
  });
  assert.equal(head.number, 102n);
  assert.equal(h.reads(), 3);
});

test("a provider that never catches up is refused within the existing deadline, not treated as zero lag", async () => {
  const h = harness([100n]);
  await assert.rejects(
    () =>
      waitForRpcHead(h.client, 102n, 1200, {
        pollMs: 100,
        now: h.now,
        sleep: h.sleep,
      }),
    /RPC head|freshness/,
  );
  assert(h.reads() <= 3);
});

test("pause or stop during head alignment aborts without returning a candidate", async () => {
  const h = harness([100n, 102n]);
  const abort = new AbortController();
  await assert.rejects(
    () =>
      waitForRpcHead(h.client, 102n, 2000, {
        pollMs: 100,
        signal: abort.signal,
        now: h.now,
        sleep: async (ms) => {
          await h.sleep(ms);
          abort.abort(new Error("stopped"));
        },
      }),
    /stopped/,
  );
  assert.equal(h.reads(), 1);
});

test("a current provider does not wait and provider exceptions are not converted to a fabricated head", async () => {
  const h = harness([105n]);
  assert.equal(
    (
      await waitForRpcHead(h.client, 102n, 2000, {
        pollMs: 100,
        now: h.now,
        sleep: h.sleep,
      })
    ).number,
    105n,
  );
  assert.equal(h.reads(), 1);
  await assert.rejects(
    () =>
      waitForRpcHead(
        {
          getBlock: async () => {
            throw Error("RPC unavailable");
          },
        } as unknown as PublicClient,
        102n,
        2000,
        { pollMs: 100, now: h.now, sleep: h.sleep },
      ),
    /RPC unavailable/,
  );
});

test("a late RPC response cannot revive an expired quote even when its height caught up", async () => {
  let now = 1000;
  const client = {
    getBlock: async () => {
      now = 2001;
      return { number: 102n, hash: hash(102), timestamp: 1n };
    },
  } as unknown as PublicClient;
  await assert.rejects(
    () => waitForRpcHead(client, 102n, 2000, { pollMs: 100, now: () => now }),
    /after.*freshness/,
  );
});
