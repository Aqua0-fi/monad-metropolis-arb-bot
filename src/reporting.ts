import { economicsReviewSchema, type EconomicsSnapshot } from "./economics.js";
import { RuntimeControls, runtimeChangeSchema } from "./runtime-controls.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HistoryStore, historyQuerySchema } from "./history.js";
import type { ObservationStore } from "./observations.js";
import { observationQuerySchema } from "./observation-wire.js";
import type { SwapVMMarketCatalog } from "./swapvm-catalog.js";
import { MarketCatalog, marketPolicyInput } from "./market-catalog.js";

export interface ReportOptions {
  economicReview?:
    | ((input: unknown, actor: string) => Promise<EconomicsSnapshot>)
    | undefined;
  controls?: RuntimeControls | undefined;
  onPolicyChanged?: ((chainId: number) => void) | undefined;
  network: "mainnet" | "fork";
  token?: string | undefined;
  controlToken?: string | undefined;
  catalog?: MarketCatalog | undefined;
  swapVMCatalog?: SwapVMMarketCatalog | undefined;
  hostHealth?: (() => unknown) | undefined;
  observations?: ObservationStore | undefined;
  history: HistoryStore;
  status: () => unknown;
  health: () => { healthy: boolean; metrics: unknown };
}
function send(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}

/** Report reads cannot change permissions. Policy writes have separate credentials and can make a route eligible on an already-enabled worker. */
export function createReportServer(options: ReportOptions) {
  if (
    options.token !== undefined &&
    (options.token.length < 32 || options.token.length > 512)
  )
    throw new Error(
      "Reporting token must contain at least 32 characters and at most 512",
    );
  const expected =
    options.token === undefined
      ? null
      : createHash("sha256").update(options.token).digest();
  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    if (!expected || !header?.startsWith("Bearer ")) return false;
    return timingSafeEqual(
      expected,
      createHash("sha256").update(header.slice(7)).digest(),
    );
  };
  if (
    options.controlToken !== undefined &&
    (options.controlToken.length < 32 || options.controlToken.length > 512)
  )
    throw new Error("Control token must contain 32 to 512 characters");
  if (options.controlToken && options.controlToken === options.token)
    throw new Error("Report and control credentials must be distinct");
  const controlHash = options.controlToken
    ? createHash("sha256").update(options.controlToken).digest()
    : null;
  const controlsAuthorized = (req: IncomingMessage) =>
    !!controlHash &&
    !!req.headers.authorization?.startsWith("Bearer ") &&
    timingSafeEqual(
      controlHash,
      createHash("sha256").update(req.headers.authorization.slice(7)).digest(),
    );
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "POST" && url.pathname === "/v1/economics/review") {
        if (!controlsAuthorized(req)) {
          send(res, 401, {
            error: "Separate operator-control credential required",
          });
          return;
        }
        if (!options.economicReview) {
          send(res, 503, { error: "Economic review is unavailable" });
          return;
        }
        if (!req.headers["content-type"]?.startsWith("application/json")) {
          send(res, 415, { error: "JSON body required" });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const part of req) {
          const buffer = Buffer.from(part);
          size += buffer.length;
          if (size > 4096) {
            send(res, 413, { error: "Review request is too large" });
            return;
          }
          chunks.push(buffer);
        }
        const body = z
          .object({
            network: z.literal(options.network),
            actor: z.string().min(1).max(120),
            change: economicsReviewSchema,
          })
          .strict()
          .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        try {
          const state = await options.economicReview(body.change, body.actor);
          options.onPolicyChanged?.(0);
          send(res, 200, {
            version: 1,
            state,
            tradingPermissionsChanged: false,
          });
        } catch (error) {
          const conflict =
            error instanceof Error &&
            /version conflict|history changed/.test(error.message);
          send(res, conflict ? 409 : 503, {
            error: conflict
              ? "Economic evidence changed. Refresh and inspect it before reviewing again."
              : "Economic review was not confirmed. Pending receipts, missing fees or chain evidence must be reconciled; refresh before retrying.",
          });
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/runtime") {
        if (!controlsAuthorized(req)) {
          send(res, 401, {
            error: "Separate operator-control credential required",
          });
          return;
        }
        if (!options.controls) {
          send(res, 503, { error: "Runtime controls are unavailable" });
          return;
        }
        if (!req.headers["content-type"]?.startsWith("application/json")) {
          send(res, 415, { error: "JSON body required" });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const part of req) {
          const buffer = Buffer.from(part);
          size += buffer.length;
          if (size > 2048) {
            send(res, 413, { error: "Control request is too large" });
            return;
          }
          chunks.push(buffer);
        }
        const body = z
          .object({
            network: z.literal(options.network),
            actor: z.string().min(1).max(120),
            change: runtimeChangeSchema,
          })
          .strict()
          .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        try {
          const state = options.controls.change(body.change, body.actor);
          if (body.change.chainId)
            options.onPolicyChanged?.(body.change.chainId);
          else options.onPolicyChanged?.(0);
          send(res, 200, {
            version: 1,
            state,
            tradingPermissionsChanged: false,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith("Control version conflict")
          ) {
            send(res, 409, { error: error.message });
            return;
          }
          throw error;
        }
        return;
      }
      const controlPath =
        /^\/v1\/(markets|aqua-markets)\/(\d+)\/(0x[0-9a-fA-F]{64})\/policy$/.exec(
          url.pathname,
        );
      const controlCatalog =
        controlPath?.[1] === "aqua-markets"
          ? options.swapVMCatalog
          : options.catalog;
      if (req.method === "POST" && controlPath && controlCatalog) {
        if (!controlsAuthorized(req)) {
          send(res, 401, {
            error: "Separate market-control authorization required",
          });
          return;
        }
        if (
          !req.headers["content-type"]
            ?.toLowerCase()
            .startsWith("application/json")
        ) {
          send(res, 415, { error: "JSON policy body required" });
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const part of req) {
          const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
          bytes += chunk.length;
          if (bytes > 8192) {
            send(res, 413, { error: "Policy request is too large" });
            return;
          }
          chunks.push(chunk);
        }
        const body = z
          .object({
            network: z.literal(options.network),
            actor: z.string().min(1).max(120),
            policy: marketPolicyInput,
          })
          .strict()
          .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const chainId = Number(controlPath[2]);
        if (!Number.isSafeInteger(chainId) || chainId <= 0) {
          send(res, 400, { error: "Invalid chain" });
          return;
        }
        try {
          const policy = controlCatalog.setPolicy(
            chainId,
            controlPath[3]!,
            body.policy,
            body.actor,
          );
          options.onPolicyChanged?.(chainId);
          send(res, 200, {
            version: 1,
            policy,
            executionActivationSupported: false,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith("Policy version conflict")
          ) {
            send(res, 409, { error: error.message });
            return;
          }
          if (
            error instanceof Error &&
            /^(Unknown discovered|Policy (base|class)|Market cannot)/.test(
              error.message,
            )
          ) {
            send(res, 400, { error: error.message });
            return;
          }
          throw error;
        }
        return;
      }
      if (req.method !== "GET") {
        send(res, 405, { error: "Read-only service" });
        return;
      }
      if (url.pathname === "/health") {
        const health = options.health();
        send(res, health.healthy ? 200 : 503, health.metrics);
        return;
      }
      if (!authorized(req)) {
        send(res, 401, { error: "Reporting authorization required" });
        return;
      }
      if (url.pathname === "/v1/markets") {
        if (!options.catalog) {
          send(res, 503, { error: "Public discovery is not configured" });
          return;
        }
        send(res, 200, {
          ...options.catalog.list(),
          controlConfigured: !!controlHash,
        });
        return;
      }
      if (url.pathname === "/v1/aqua-markets") {
        if (!options.swapVMCatalog) {
          send(res, 503, { error: "SwapVM discovery is not configured" });
          return;
        }
        send(res, 200, {
          ...options.swapVMCatalog.list(),
          controlConfigured: !!controlHash,
        });
        return;
      }
      if (url.pathname === "/v1/host-health") {
        send(
          res,
          200,
          options.hostHealth?.() ?? {
            available: false,
            reason: "Host watchdog is not configured",
          },
        );
        return;
      }
      if (url.pathname === "/v1/status") {
        send(res, 200, {
          ...(options.status() as object),
          runtimeControlAvailable: !!options.controls && !!controlHash,
          economicReviewAvailable: !!options.economicReview && !!controlHash,
        });
        return;
      }
      if (
        url.pathname === "/v1/opportunities" ||
        url.pathname === "/v1/balances"
      ) {
        if (!options.observations) {
          send(res, 503, {
            error: "Observation history is disabled or unavailable",
          });
          return;
        }
        const supplied = Object.fromEntries(url.searchParams);
        if (supplied.network && supplied.network !== options.network) {
          send(res, 400, { error: "Reporting network mismatch" });
          return;
        }
        const query = observationQuerySchema.parse({
          ...supplied,
          network: options.network,
        });
        send(
          res,
          200,
          url.pathname === "/v1/opportunities"
            ? options.observations.opportunities(query)
            : options.observations.balances(query),
        );
        return;
      }
      if (url.pathname === "/v1/executions") {
        const supplied = Object.fromEntries(url.searchParams);
        if (supplied.network && supplied.network !== options.network) {
          send(res, 400, { error: "Reporting network mismatch" });
          return;
        }
        const query = historyQuerySchema.parse({
          ...supplied,
          network: options.network,
        });
        send(res, 200, options.history.list(query));
        return;
      }
      const match = /^\/v1\/executions\/(\d+)\/(0x[0-9a-fA-F]{64})$/.exec(
        url.pathname,
      );
      if (match) {
        const chainId = Number(match[1]);
        if (!Number.isSafeInteger(chainId) || chainId <= 0) {
          send(res, 400, { error: "Invalid chain" });
          return;
        }
        const record = options.history.get(options.network, chainId, match[2]!);
        send(
          res,
          record ? 200 : 404,
          record ? { version: 1, record } : { error: "Execution not found" },
        );
        return;
      }
      send(res, 404, { error: "Unknown reporting route" });
    } catch (error) {
      const invalid =
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        (error instanceof Error &&
          (error.message.startsWith("Invalid history cursor") ||
            error.message.startsWith("Invalid observation cursor") ||
            error.message.startsWith("Filters do not belong")));
      send(res, invalid ? 400 : 503, {
        error: invalid
          ? "Invalid reporting query"
          : "Requested reporting history is unavailable",
      });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}
