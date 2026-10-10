import { setTimeout as sleep } from "node:timers/promises";
import { BlockNotFoundError, type PublicClient } from "viem";
import { StaleCandidateError } from "./freshness.js";
import { waitForRpcHead } from "./rpc-head.js";
import { assertFresh, type Candidate } from "./strategy.js";

/** Validate a backend V4 quote against real worker-RPC evidence. A nearby provider
 * may lag the backend; that is not permission to invent a head or skip its hash.
 * Both initial selection and selected-route refresh use this before authorization.
 */
export async function verifyV4Quote(
  client: PublicClient,
  candidate: Pick<Candidate, "quotedAt" | "blockNumber" | "quoteBlockHash">,
  policy: {
    maxQuoteAgeMs: number;
    maxBlockLag: number;
    scheduling: { headerPollMs: number };
  },
  options: {
    signal?: AbortSignal | undefined;
    check?: () => void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  if (
    !candidate.quoteBlockHash ||
    !/^0x[0-9a-f]{64}$/i.test(candidate.quoteBlockHash)
  )
    throw new Error("V4 quote is missing a valid canonical block hash");
  const now = options.now ?? Date.now;
  const deadline = candidate.quotedAt + policy.maxQuoteAgeMs;
  const check = () => {
    options.signal?.throwIfAborted();
    options.check?.();
  };
  const pause = async (ms: number) => {
    check();
    if (options.sleep) await options.sleep(ms);
    else await sleep(ms, undefined, { signal: options.signal });
    check();
  };
  for (;;) {
    check();
    const head = await waitForRpcHead(client, candidate.blockNumber, deadline, {
      pollMs: policy.scheduling.headerPollMs,
      signal: options.signal,
      now,
      sleep: pause,
    });
    check();
    assertFresh(
      candidate,
      head.number,
      now(),
      policy.maxQuoteAgeMs,
      policy.maxBlockLag,
    );
    let canonical;
    try {
      // This is the RPC's actual full block, not a synthetic quote-height head.
      canonical =
        head.number === candidate.blockNumber
          ? head
          : await client.getBlock({ blockNumber: candidate.blockNumber });
    } catch (error) {
      if (!(error instanceof BlockNotFoundError)) throw error;
      check();
      // A load-balanced RPC can serve the head and the pinned lookup from nodes
      // at different heights. Retry only this typed absence, within the SAME budget.
      const remaining = deadline - now();
      if (remaining <= 0)
        throw new StaleCandidateError(
          "RPC did not provide the V4 quote block within its freshness budget",
        );
      await pause(Math.min(policy.scheduling.headerPollMs, remaining));
      continue;
    }
    check();
    assertFresh(
      candidate,
      head.number,
      now(),
      policy.maxQuoteAgeMs,
      policy.maxBlockLag,
    );
    if (
      canonical.number !== candidate.blockNumber ||
      canonical.hash?.toLowerCase() !== candidate.quoteBlockHash.toLowerCase()
    )
      throw new StaleCandidateError(
        "V4 quote block reorganized; discard and requote",
      );
    return head;
  }
}
