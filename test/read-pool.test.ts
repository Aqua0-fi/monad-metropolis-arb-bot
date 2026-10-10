import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { ReadPool } from "../src/read-pool.js";
test("read work is bounded and cancelled queued requests never reach the provider", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r)),
    pool = new ReadPool(1);
  const started: number[] = [];
  const first = pool.run(async () => {
    started.push(1);
    await hold;
    return 1;
  });
  await turn();
  const controller = new AbortController();
  const second = pool.run(async () => {
    started.push(2);
    return 2;
  }, controller.signal);
  const rejected = assert.rejects(second);
  const third = pool.run(async () => {
    started.push(3);
    return 3;
  });
  controller.abort();
  await rejected;
  assert.deepEqual(started, [1]);
  assert.equal(pool.status().active, 1);
  release();
  assert.deepEqual(await Promise.all([first, third]), [1, 3]);
  await turn();
  assert.deepEqual(started, [1, 3]);
  assert.equal(pool.status().queued, 0);
});

test("one slow chain cannot occupy all read slots and selected-trade checks jump ahead of queued searches", async () => {
  const pool = new ReadPool(4, 2);
  const releases: (() => void)[] = [];
  const starts: string[] = [];
  const job = (name: string, group: string, priority = 0) =>
    pool.run(
      async () => {
        starts.push(name);
        await new Promise<void>((r) => releases.push(r));
        return name;
      },
      undefined,
      priority,
      group,
    );
  const jobs = [
    job("A1", "A"),
    job("A2", "A"),
    job("A3", "A"),
    job("B1", "B"),
    job("B2", "B"),
  ];
  await turn();
  assert.deepEqual(starts, ["A1", "A2", "B1", "B2"]);
  jobs.push(job("A-selected", "A", 1));
  releases.shift()!();
  await turn();
  assert.equal(starts[4], "A-selected");
  for (let i = 0; i < 10; i++) {
    releases.splice(0).forEach((r) => r());
    await turn();
  }
  await Promise.all(jobs);
  assert.equal(pool.status().active, 0);
  assert.equal(starts[5], "A3");
});
