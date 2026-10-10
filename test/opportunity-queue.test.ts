import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { ReadyOpportunityQueue } from "../src/opportunity-queue.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
}
test("a ready profitable venue reaches execution without waiting for a slow unrelated quote", async () => {
  const held = deferred();
  let attempted = 0,
    stopped = 0;
  const q = new ReadyOpportunityQueue<number>(
    (a, b) => b - a,
    async (value) => {
      attempted = value;
      return true;
    },
    () => {
      stopped++;
    },
  );
  const slow = held.promise.then(() => q.offer(999));
  q.offer(10);
  await q.settle();
  assert.equal(attempted, 10);
  assert.equal(stopped, 1);
  held.resolve();
  await slow;
  await q.settle();
  assert.equal(attempted, 10);
});
test("only one execution attempt is in flight and the best already-ready candidate is first", async () => {
  const held = deferred();
  const attempts: number[] = [];
  let active = 0,
    peak = 0;
  const q = new ReadyOpportunityQueue<number>(
    (a, b) => b - a,
    async (n) => {
      active++;
      peak = Math.max(peak, active);
      attempts.push(n);
      await held.promise;
      active--;
      return n === 9;
    },
    () => {},
  );
  q.offer(1);
  q.offer(9);
  q.offer(4);
  await turn();
  assert.deepEqual(attempts, [9]);
  held.resolve();
  await q.settle();
  assert.equal(peak, 1);
  assert.deepEqual(attempts, [9]);
});
test("an uncertain send error stops the queue instead of trying another trade", async () => {
  const attempts: number[] = [];
  const q = new ReadyOpportunityQueue<number>(
    (a, b) => b - a,
    async (n) => {
      attempts.push(n);
      throw Error("uncertain send");
    },
    () => {},
  );
  q.offer(2);
  q.offer(1);
  await assert.rejects(q.settle(), /uncertain send/);
  assert.deepEqual(attempts, [2]);
});

test("a change in shared backing or the external pool discards queued quotes before another attempt", async () => {
  for (const changed of ["shared-USDC-vault", "external-pool"]) {
    const held = deferred();
    let revision = 0;
    const attempted: string[] = [];
    const q = new ReadyOpportunityQueue<{ name: string; revision: number }>(
      (a, b) => a.name.localeCompare(b.name),
      async (value) => {
        attempted.push(value.name);
        if (value.name === "first") await held.promise;
        return false;
      },
      () => {},
      (value) => value.revision === revision,
    );
    q.offer({ name: "first", revision });
    await turn();
    q.offer({ name: "USDC-DAI", revision });
    q.offer({ name: "USDC-ETH", revision });
    revision++;
    held.resolve();
    await q.settle();
    assert.deepEqual(attempted, ["first"], changed);
  }
});
