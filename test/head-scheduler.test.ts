import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { LatestHeadScheduler, type ScanTask } from "../src/head-scheduler.js";
const head = (n: number, fork = 0) => ({
  number: BigInt(n),
  hash: `0x${(n + fork * 10000).toString(16).padStart(64, "0")}` as `0x${string}`,
  parentHash:
    `0x${(n - 1 + fork * 10000).toString(16).padStart(64, "0")}` as `0x${string}`,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
test("a blocked chain never delays another chain and only the newest queued block is run", async () => {
  const slow = deferred(),
    starts: string[] = [];
  const scheduler = new LatestHeadScheduler({
    maxConcurrent: 2,
    maxBlockLag: 2,
    maxTaskMs: 5000,
    run: async (id, t) => {
      starts.push(`${id}:${t.head.number}`);
      if (id === 1 && t.head.number === 1n) await slow.promise;
    },
  });
  scheduler.notify(1, head(1));
  scheduler.notify(2, head(1));
  await turn();
  assert.deepEqual(starts, ["1:1", "2:1"]);
  for (let n = 2; n <= 100; n++) scheduler.notify(1, head(n));
  await turn();
  assert.equal(scheduler.status()[0]!.queued, true);
  assert.equal(starts.length, 2);
  slow.resolve();
  await scheduler.drain();
  assert.deepEqual(starts, ["1:1", "2:1", "1:100"]);
  await scheduler.stop();
});
test("duplicates do not rescan, same-height reorg invalidates old work, and stop drains rather than releasing a live lane", async () => {
  const held = deferred();
  let task: ScanTask | undefined;
  let calls = 0;
  const scheduler = new LatestHeadScheduler({
    maxConcurrent: 1,
    maxBlockLag: 2,
    maxTaskMs: 5000,
    run: async (_, t) => {
      calls++;
      task = t;
      await held.promise;
    },
  });
  scheduler.notify(1, head(9));
  await turn();
  scheduler.notify(1, head(9));
  assert.equal(calls, 1);
  assert.doesNotThrow(() => task!.assertCurrent());
  scheduler.notify(1, head(9, 1));
  assert.throws(() => task!.assertCurrent(), /obsolete|reorg|abort/i);
  let stopped = false;
  const stopping = scheduler.stop().then(() => {
    stopped = true;
  });
  await turn();
  assert.equal(stopped, false);
  held.resolve();
  await stopping;
  assert.equal(calls, 1);
  scheduler.notify(1, head(10));
  await turn();
  assert.equal(calls, 1);
});
test("fast new blocks do not starve still-fresh work, but work beyond its block or time budget cannot submit", async () => {
  const held = deferred();
  let task: ScanTask | undefined;
  let now = 0;
  const scheduler = new LatestHeadScheduler({
    maxConcurrent: 1,
    maxBlockLag: 2,
    maxTaskMs: 5000,
    now: () => now,
    run: async (_, t) => {
      task = t;
      await held.promise;
    },
  });
  scheduler.notify(1, head(1));
  await turn();
  scheduler.notify(1, head(2));
  assert.doesNotThrow(() => task!.assertCurrent());
  scheduler.notify(1, head(4));
  assert.throws(() => task!.assertCurrent());
  held.resolve();
  await scheduler.drain();
  now = 6000;
  assert.throws(() => task!.assertCurrent());
  await scheduler.stop();
});
test("global concurrency is bounded and queued chains get a turn before a busy chain runs again", async () => {
  const held = deferred();
  const calls: number[] = [];
  const s = new LatestHeadScheduler({
    maxConcurrent: 1,
    maxBlockLag: 2,
    maxTaskMs: 5000,
    run: async (id) => {
      calls.push(id);
      if (calls.length === 1) await held.promise;
    },
  });
  s.notify(1, head(1));
  await turn();
  s.notify(1, head(2));
  s.notify(2, head(1));
  held.resolve();
  await s.drain();
  assert.deepEqual(calls, [1, 2, 1]);
  await s.stop();
});

test("a quote completed after a fast block can trigger a fresh check, but queued work and signed state cannot use old revisions", async () => {
  const held = deferred();
  let task: ScanTask | undefined;
  const scheduler = new LatestHeadScheduler({
    maxConcurrent: 1,
    maxBlockLag: 3,
    maxTaskMs: 5000,
    run: async (_, t) => {
      task = t;
      await held.promise;
    },
  });
  scheduler.notify(1, head(10));
  await turn();
  const oldRevision = task!.queueRevision();
  scheduler.notify(1, head(11));
  assert.notEqual(task!.queueRevision(), oldRevision);
  assert.doesNotThrow(
    () => task!.adoptQuote(10n, head(10).hash),
    "bounded provisional quotes can trigger a mandatory fresh simulation rather than starving fast chains",
  );
  assert.throws(
    () => task!.bindSnapshot(10n, head(10).hash),
    "signing still needs the latest known simulated state",
  );
  task!.bindSnapshot(11n, head(11).hash);
  assert.doesNotThrow(() => task!.assertCurrent());
  const queued = task!.queueRevision();
  scheduler.notify(1, head(12));
  assert.notEqual(task!.queueRevision(), queued);
  held.resolve();
  await scheduler.drain();
  await scheduler.stop();
});

test("a retry-backoff skip does not pretend to be an extremely fast completed work pass", async () => {
  const scheduler = new LatestHeadScheduler({
    maxConcurrent: 1,
    maxBlockLag: 2,
    maxTaskMs: 5000,
    run: async () => false as const,
  });
  scheduler.notify(1, head(1));
  await scheduler.drain();
  const status = scheduler.status()[0]!;
  assert.equal(status.completed, 0);
  assert.equal(status.durationP50Ms, null);
  assert.equal(status.startDelayP95Ms, null);
  await scheduler.stop();
});
