import { createPublicClient, webSocket, type PublicClient } from "viem";
import type { ObservedHead } from "./head-scheduler.js";
export interface HeadFeedOptions {
  chainId: number;
  client: PublicClient;
  websocketUrl?: string;
  pollMs: number;
  auditMs: number;
  onHead(head: ObservedHead): void;
  onError(error: unknown): void;
}
/** WebSocket pushes with independent HTTP recovery. Never infer a paid endpoint or put its URL in logs. */
export function startHeadFeed(options: HeadFeedOptions) {
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    unwatch: (() => void) | undefined;
  let socketClient: ReturnType<typeof createSocketClient> | undefined;
  let lastPush = 0,
    httpVerified = false,
    socketReady = false;
  let delivered: ObservedHead | undefined;
  let generation = 0;
  const status = {
    transport: "http" as "http" | "websocket" | "http-fallback",
    lastHeaderAt: 0,
    errors: 0,
    httpChecks: 0,
    websocketHeaders: 0,
  };
  const error = (e: unknown) => {
    if (!stopped) {
      status.errors++;
      options.onError(e);
    }
  };
  const emit = (
    b: {
      number: bigint | null;
      hash: `0x${string}` | null;
      parentHash: `0x${string}`;
    },
    pushed: boolean,
  ) => {
    if (stopped || b.number === null || b.hash === null) return;
    status.lastHeaderAt = Date.now();
    if (pushed) {
      lastPush = Date.now();
      status.websocketHeaders++;
      status.transport = "websocket";
    }
    delivered = { number: b.number, hash: b.hash, parentHash: b.parentHash };
    generation++;
    options.onHead(delivered);
  };
  const poll = async () => {
    const started = Date.now(),
      requestGeneration = generation;
    try {
      // This audit also detects a silent socket or a missed reconnect. It does not wait for a scan.
      if (!socketReady || Date.now() - lastPush >= options.auditMs) {
        if (!httpVerified) {
          if ((await options.client.getChainId()) !== options.chainId)
            throw new Error("HTTP head source chain mismatch");
          httpVerified = true;
        }
        const block = await options.client.getBlock();
        status.httpChecks++;
        if (delivered && block.number !== null) {
          const older = block.number < delivered.number;
          const conflicting =
            block.number === delivered.number && block.hash !== delivered.hash;
          // A response already in flight cannot overrule a newer subscription notification.
          if (generation !== requestGeneration && (older || conflicting))
            return;
          if (older) {
            // Providers can lag independently. A lower reported tip alone is not reorg evidence.
            const observed = await options.client.getBlock({
              blockNumber: delivered.number,
            });
            if (observed.hash === delivered.hash) return;
          }
        }
        if (options.websocketUrl) status.transport = "http-fallback";
        emit(block, false);
      }
    } catch (e) {
      httpVerified = false;
      error(e);
    } finally {
      if (!stopped)
        timer = setTimeout(
          () => {
            void poll();
          },
          Math.max(20, options.pollMs - (Date.now() - started)),
        );
    }
  };
  const connecting = (async () => {
    if (!options.websocketUrl) return;
    try {
      const url = new URL(options.websocketUrl);
      if (!["wss:", "ws:"].includes(url.protocol))
        throw new Error("WebSocket head source must use ws or wss");
      socketClient = createSocketClient(options.websocketUrl);
      if ((await socketClient.getChainId()) !== options.chainId)
        throw new Error("WebSocket head source chain mismatch");
      if (stopped) return;
      socketReady = true;
      unwatch = socketClient.watchBlocks({
        onBlock: (block) => emit(block, true),
        onError: error,
      });
    } catch (e) {
      socketReady = false;
      error(e);
    }
  })();
  void poll();
  return {
    status: () => ({ ...status }),
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      unwatch?.();
      await connecting;
      unwatch?.();
      if (socketClient) {
        try {
          (await socketClient.transport.getRpcClient()).close();
        } catch {
          /* No connected socket remains. */
        }
      }
    },
  };
}
function createSocketClient(url: string) {
  return createPublicClient({
    cacheTime: 0,
    transport: webSocket(url, {
      timeout: 4000,
      retryCount: 0,
      reconnect: { attempts: 20, delay: 500 },
      keepAlive: { interval: 10000 },
    }),
  });
}
