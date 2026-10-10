import test from "node:test";
import assert from "node:assert/strict";
import { BlockNotFoundError, type Hex, type PublicClient } from "viem";
import { verifyV4Quote } from "../src/v4-quote-state.js";
import { StaleCandidateError } from "../src/freshness.js";

const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const quote = () => ({
  quotedAt: 1000,
  blockNumber: 102n,
  quoteBlockHash: hash(102),
});
const policy = {
  maxQuoteAgeMs: 300,
  maxBlockLag: 8,
  scheduling: { headerPollMs: 100 },
};
function fixture(heads: bigint[], missingPinned = 0) {
  let now = 1000,
    latestReads = 0,
    pinnedReads = 0;
  const client = {
    getBlock: async (args?: { blockNumber?: bigint }) => {
      if (args?.blockNumber !== undefined) {
        if (++pinnedReads <= missingPinned)
          throw new BlockNotFoundError({ blockNumber: args.blockNumber });
        return {
          number: args.blockNumber,
          hash: hash(Number(args.blockNumber)),
          timestamp: 1n,
        };
      }
      const number = heads[Math.min(latestReads++, heads.length - 1)]!;
      return { number, hash: hash(Number(number)), timestamp: 1n };
    },
  } as unknown as PublicClient;
  return {
    client,
    options: {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    },
    setTime: (value: number) => {
      now = value;
    },
    latestReads: () => latestReads,
    pinnedReads: () => pinnedReads,
  };
}

test("V4 head alignment waits for observed evidence rather than accepting the quote's claimed height", async () => {
  const f = fixture([100n, 101n, 102n]);
  const head = await verifyV4Quote(f.client, quote(), policy, f.options);
  assert.equal(head.number, 102n);
  assert.equal(f.latestReads(), 3);
  assert.equal(
    f.pinnedReads(),
    0,
    "The actual full quote-height head already supplies canonical evidence",
  );
});

test("a head beyond the V4 quote still requires its exact pinned canonical hash", async () => {
  const f = fixture([103n]);
  await verifyV4Quote(f.client, quote(), policy, f.options);
  assert.equal(f.pinnedReads(), 1);
});

test("a load-balanced pinned-block miss is retried within the same V4 freshness budget", async () => {
  const f = fixture([103n], 1);
  await verifyV4Quote(f.client, quote(), policy, f.options);
  assert.equal(f.pinnedReads(), 2);
  assert.equal(f.options.now(), 1100);
});

test("an RPC that never supplies the V4 quote height cannot produce accepted or fabricated evidence", async () => {
  const f = fixture([101n]);
  await assert.rejects(
    () => verifyV4Quote(f.client, quote(), policy, f.options),
    StaleCandidateError,
  );
  assert.equal(f.pinnedReads(), 0);
  assert(f.latestReads() <= 4);
});

test("repeated pinned-block absence stops at the original deadline", async () => {
  const f = fixture([103n], 100);
  await assert.rejects(
    () => verifyV4Quote(f.client, quote(), policy, f.options),
    StaleCandidateError,
  );
  assert.equal(f.options.now(), 1300);
  assert.equal(f.pinnedReads(), 4);
});

test("a real V4 hash mismatch is rejected even when the provider height catches up", async () => {
  const f = fixture([102n]);
  await assert.rejects(
    () =>
      verifyV4Quote(
        f.client,
        { ...quote(), quoteBlockHash: hash(999) },
        policy,
        f.options,
      ),
    /reorganized/,
  );
  assert.equal(f.latestReads(), 1);
});

test("missing or malformed V4 hash evidence cannot reach any RPC or authorization", async () => {
  for (const candidate of [
    { quotedAt: 1000, blockNumber: 102n },
    { ...quote(), quoteBlockHash: "0x1234" as Hex },
  ]) {
    const f = fixture([102n]);
    await assert.rejects(
      () => verifyV4Quote(f.client, candidate, policy, f.options),
      /canonical block hash/,
    );
    assert.equal(f.latestReads(), 0);
  }
});

test("a V4 quote beyond the unchanged block-lag bound remains rejected", async () => {
  const f = fixture([111n]);
  await assert.rejects(
    () => verifyV4Quote(f.client, quote(), policy, f.options),
    StaleCandidateError,
  );
  assert.equal(f.pinnedReads(), 0);
});

test("expired and future-timestamp V4 quotes cannot be revived by head alignment", async () => {
  for (const quotedAt of [699, 1001]) {
    const f = fixture([102n]);
    await assert.rejects(
      () =>
        verifyV4Quote(f.client, { ...quote(), quotedAt }, policy, f.options),
      StaleCandidateError,
    );
  }
});

test("a pinned V4 hash arriving after the deadline remains stale even when it matches", async () => {
  const f = fixture([103n]);
  const getBlock = f.client.getBlock;
  f.client.getBlock = (async (args?: { blockNumber?: bigint }) => {
    const block = await getBlock(args);
    if (args?.blockNumber !== undefined) f.setTime(1301);
    return block;
  }) as typeof f.client.getBlock;
  await assert.rejects(
    () => verifyV4Quote(f.client, quote(), policy, f.options),
    StaleCandidateError,
  );
});

test("a real RPC transport failure is not converted into a transient V4 block miss", async () => {
  const f = fixture([103n]);
  const getBlock = f.client.getBlock;
  const transportError = new Error("offline transport unavailable");
  f.client.getBlock = (async (args?: { blockNumber?: bigint }) => {
    if (args?.blockNumber !== undefined) throw transportError;
    return getBlock(args);
  }) as typeof f.client.getBlock;
  await assert.rejects(
    () => verifyV4Quote(f.client, quote(), policy, f.options),
    (e: unknown) => e === transportError,
  );
  assert.equal(f.options.now(), 1000);
});

test("stop and policy-pause checks interrupt V4 alignment without admitting a candidate", async () => {
  const f = fixture([101n, 102n]);
  const stop = new AbortController();
  await assert.rejects(
    () =>
      verifyV4Quote(f.client, quote(), policy, {
        ...f.options,
        signal: stop.signal,
        sleep: async (ms) => {
          await f.options.sleep(ms);
          stop.abort(new Error("test stop"));
        },
      }),
    /test stop/,
  );
  assert.equal(f.latestReads(), 1);
  const g = fixture([101n, 102n]);
  let paused = false;
  await assert.rejects(
    () =>
      verifyV4Quote(g.client, quote(), policy, {
        ...g.options,
        check: () => {
          if (paused) throw new Error("test paused");
        },
        sleep: async (ms) => {
          await g.options.sleep(ms);
          paused = true;
        },
      }),
    /test paused/,
  );
  assert.equal(g.latestReads(), 1);
});
