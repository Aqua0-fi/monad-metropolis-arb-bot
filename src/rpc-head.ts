import { setTimeout as sleep } from "node:timers/promises";
import type { PublicClient } from "viem";
import { StaleCandidateError } from "./freshness.js";

/** Different providers can report nearby heads out of order. Wait within the existing deadline;
 * never accept a future quote by replacing the RPC height with a caller-supplied number.
 */
export async function waitForRpcHead(
  client: PublicClient,
  minimum: bigint,
  deadline: number,
  options: {
    pollMs: number;
    signal?: AbortSignal | undefined;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
) {
  const now = options.now ?? Date.now;
  if (
    minimum < 0n ||
    !Number.isFinite(deadline) ||
    !Number.isSafeInteger(options.pollMs) ||
    options.pollMs < 1 ||
    options.pollMs > 10000
  )
    throw new Error("Invalid RPC head alignment bounds");
  for (;;) {
    options.signal?.throwIfAborted();
    if (now() > deadline)
      throw new StaleCandidateError(
        "RPC head did not catch up within the quote freshness budget",
      );
    const head = await client.getBlock();
    options.signal?.throwIfAborted();
    if (now() > deadline)
      throw new StaleCandidateError(
        "RPC head response arrived after the quote freshness budget",
      );
    if (head.number >= minimum) return head;
    const remaining = deadline - now();
    if (remaining <= 0)
      throw new StaleCandidateError(
        `RPC head ${head.number} is behind quote ${minimum}; freshness budget expired`,
      );
    const delay = Math.min(options.pollMs, remaining);
    if (options.sleep) await options.sleep(delay);
    else await sleep(delay, undefined, { signal: options.signal });
  }
}
