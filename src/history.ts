import {
  feeValuationSchema,
  summarizeEconomics,
  economicsReviewSchema,
  type EconomicsSnapshot,
  type EconomicPauseReason,
} from "./economics.js";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

const addr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase());
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v.toLowerCase());
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(80);
const sint = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)$/)
  .max(81);
const timestamp = z.iso
  .datetime()
  .transform((value) => new Date(value).toISOString());
const swapVMIdentitySchema = z.object({
  stableStrategyId: hash,
  classId: uint,
  orderHash: hash,
  router: addr,
  maker: addr,
  aqua: addr,
});
const swapVMReceiptSchema = z.object({
  strategyId: hash,
  classId: uint,
  orderHash: hash,
  router: addr,
  maker: addr,
  tokenIn: addr,
  tokenOut: addr,
  amountIn: uint,
  amountOut: uint,
  logIndex: z.number().int().nonnegative(),
});
export const receiptSchema = z.object({
  feeValuation: feeValuationSchema.nullable().optional(),
  feeIssue: z.string().max(160).nullable().optional(),
  swapVM: swapVMReceiptSchema.optional(),
  blockNumber: uint,
  blockHash: hash,
  blockTimestamp: timestamp,
  checkedAt: timestamp,
  logIndex: z.number().int().nonnegative().nullable(),
  grossProfit: uint.nullable(),
  executionGasNative: uint,
  additionalGasNative: uint.nullable(),
  totalGasNative: uint.nullable(),
  settlements: z
    .array(
      z.object({
        swapId: hash,
        classId: uint,
        logIndex: z.number().int().nonnegative(),
        token0: addr,
        delta0: sint,
        token1: addr,
        delta1: sint,
      }),
    )
    .max(500),
});
export const executionSchema = z
  .object({
    version: z.literal(1),
    feePolicy: z
      .object({
        feeModel: z.enum(["op-stack", "gas-limit", "unsupported"]),
        nativeCurrency: z
          .object({
            symbol: z.string().min(1).max(32),
            decimals: z.number().int().min(0).max(36),
          })
          .nullable(),
        nativeEquivalent: z
          .object({ token: addr, decimals: z.number().int().min(0).max(36) })
          .nullable(),
        wrappedNative: addr,
        gasConversionFee: z.number().int().positive().max(1000000),
        venues: z.array(z.object({ factory: addr, quoter: addr })).max(16),
      })
      .strict()
      .optional(),
    network: z.enum(["mainnet", "fork"]),
    chainId: z.number().int().positive().safe(),
    transactionHash: hash,
    tradeId: hash,
    executor: addr,
    operator: addr,
    venue: z.enum(["v4", "aqua"]).optional(),
    poolId: hash.nullable(),
    swapVM: swapVMIdentitySchema.optional(),
    aqua0Hook: addr,
    tokenIn: addr,
    tokenOut: addr,
    amountIn: uint,
    minimumProfit: uint,
    quotedNetProfit: sint,
    aquaFirst: z.boolean(),
    preparedAt: timestamp,
    status: z.enum(["pending", "confirmed", "reverted"]),
    broadcastAcknowledged: z.boolean(),
    receipt: receiptSchema.nullable(),
  })
  .refine(
    (r) =>
      r.venue === "aqua"
        ? r.poolId === null && !!r.swapVM
        : r.poolId !== null && !r.swapVM,
    "Venue identity mismatch",
  )
  .refine(
    (r) => (r.status === "pending" ? r.receipt === null : r.receipt !== null),
    "Receipt/state mismatch",
  );
export type ExecutionRecord = z.infer<typeof executionSchema>;
export const historyQuerySchema = z
  .object({
    network: z.enum(["mainnet", "fork"]),
    chainId: z.coerce.number().int().positive().safe().optional(),
    token: addr.optional(),
    poolId: hash.optional(),
    status: z.enum(["pending", "confirmed", "reverted"]).optional(),
    from: timestamp.optional(),
    to: timestamp.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(512).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, "Invalid time window");
export type HistoryQuery = z.input<typeof historyQuerySchema>;
export interface HistoryPage {
  version: 1;
  items: ExecutionRecord[];
  nextCursor: string | null;
  matchedCount: number;
  generatedAt: string;
}

function immutable(r: ExecutionRecord): string {
  const { status: _, broadcastAcknowledged: __, receipt: ___, ...identity } = r;
  return JSON.stringify(identity);
}
function fingerprint(q: z.infer<typeof historyQuerySchema>): string {
  const { cursor: _, limit: __, ...filters } = q;
  return createHash("sha256").update(JSON.stringify(filters)).digest("hex");
}

/** One embedded file, not another database service. FULL synchronous commits precede broadcasting. */
export class HistoryStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS executions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, network TEXT NOT NULL, chain_id INTEGER NOT NULL,
        transaction_hash TEXT NOT NULL, token_in TEXT NOT NULL, token_out TEXT NOT NULL,
        pool_id TEXT NOT NULL, status TEXT NOT NULL, prepared_at TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE(network, chain_id, transaction_hash)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS executions_chain ON executions(network,chain_id,seq DESC);
      CREATE INDEX IF NOT EXISTS executions_status ON executions(network,status,seq DESC);
      CREATE INDEX IF NOT EXISTS executions_pair ON executions(network,pool_id,seq DESC);
      CREATE TABLE IF NOT EXISTS economic_settlements (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, network TEXT NOT NULL, chain_id INTEGER NOT NULL, transaction_hash TEXT NOT NULL,
        UNIQUE(network,chain_id,transaction_hash)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS economic_controls (
        network TEXT PRIMARY KEY, version INTEGER NOT NULL, reviewed_seq INTEGER NOT NULL DEFAULT 0,
        latched INTEGER NOT NULL DEFAULT 0, reason TEXT, reviewed_at TEXT, reviewed_by TEXT, review_reason TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS economic_reviews (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, network TEXT NOT NULL, through_seq INTEGER NOT NULL,
        actor TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL, previous_result TEXT NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO economic_settlements(network,chain_id,transaction_hash)
        SELECT network,chain_id,transaction_hash FROM executions WHERE status!='pending' ORDER BY seq;`);
  }
  close(): void {
    this.db.close();
  }
  get(
    network: string,
    chainId: number,
    transactionHash: string,
  ): ExecutionRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT payload FROM executions WHERE network=? AND chain_id=? AND transaction_hash=?",
      )
      .get(network, chainId, transactionHash.toLowerCase());
    return row
      ? executionSchema.parse(JSON.parse(String(row.payload)))
      : undefined;
  }
  prepare(input: ExecutionRecord): void {
    const r = executionSchema.parse(input);
    const existing = this.get(r.network, r.chainId, r.transactionHash);
    if (existing) {
      if (immutable(existing) !== immutable(r))
        throw new Error("Execution identity conflict");
      return;
    }
    if (r.status !== "pending")
      throw new Error("New history must be prepared before broadcast");
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO executions(network,chain_id,transaction_hash,token_in,token_out,pool_id,status,prepared_at,payload)
      VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          r.network,
          r.chainId,
          r.transactionHash,
          r.tokenIn,
          r.tokenOut,
          r.poolId ?? r.swapVM!.stableStrategyId,
          r.status,
          r.preparedAt,
          JSON.stringify(r),
        );
      this.touchEconomics(r.network);
    });
  }
  acknowledgeBroadcast(network: string, chainId: number, tx: string): void {
    const r = this.get(network, chainId, tx);
    if (!r) throw new Error("Missing prepared history");
    this.write({ ...r, broadcastAcknowledged: true });
  }
  settle(
    network: string,
    chainId: number,
    tx: string,
    status: "confirmed" | "reverted",
    receipt: z.infer<typeof receiptSchema>,
  ): void {
    const r = this.get(network, chainId, tx);
    if (!r) throw new Error("Missing prepared history");
    if (
      r.receipt &&
      (r.receipt.blockHash !== receipt.blockHash || r.status !== status)
    )
      throw new Error(
        "Canonical receipt changed; manual reconciliation required",
      );
    this.write(executionSchema.parse({ ...r, status, receipt }));
  }
  private write(r: ExecutionRecord): void {
    const current = this.get(r.network, r.chainId, r.transactionHash);
    if (current && JSON.stringify(current) === JSON.stringify(r)) return;
    this.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE executions SET status=?,payload=? WHERE network=? AND chain_id=? AND transaction_hash=?",
        )
        .run(
          r.status,
          JSON.stringify(r),
          r.network,
          r.chainId,
          r.transactionHash,
        );
      if (result.changes !== 1)
        throw new Error("History update did not persist");
      this.touchEconomics(r.network);
      if (r.status !== "pending") {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO economic_settlements(network,chain_id,transaction_hash) VALUES(?,?,?)",
          )
          .run(r.network, r.chainId, r.transactionHash);
        const summary = this.economics(r.network);
        const reason = summary.window.some((g) => g.unknownCost > 0)
          ? "cost_unavailable"
          : summary.window.some(
                (g) => g.netResult !== null && BigInt(g.netResult) < 0n,
              )
            ? "net_loss"
            : null;
        if (reason)
          this.db
            .prepare(
              "UPDATE economic_controls SET latched=1,reason=COALESCE(reason,?) WHERE network=?",
            )
            .run(reason, r.network);
      }
    });
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private touchEconomics(network: string): void {
    this.db
      .prepare(
        "INSERT INTO economic_controls(network,version) VALUES(?,1) ON CONFLICT(network) DO UPDATE SET version=version+1",
      )
      .run(network);
  }
  /** Settlement order, not preparation time, defines the review window. Reads never mutate controls. */
  *economicRecords(network: string, after = 0): Generator<ExecutionRecord> {
    z.enum(["mainnet", "fork"]).parse(network);
    for (const row of this.db
      .prepare(
        `SELECT e.payload FROM executions e JOIN economic_settlements s
      ON e.network=s.network AND e.chain_id=s.chain_id AND e.transaction_hash=s.transaction_hash
      WHERE s.network=? AND s.seq>? ORDER BY s.seq`,
      )
      .iterate(network, after)) {
      yield executionSchema.parse(JSON.parse(String(row.payload)));
    }
  }
  economics(rawNetwork: string): EconomicsSnapshot {
    const network = z.enum(["mainnet", "fork"]).parse(rawNetwork);
    const control = this.db
      .prepare("SELECT * FROM economic_controls WHERE network=?")
      .get(network);
    const reviewedThrough = Number(control?.reviewed_seq ?? 0);
    const totals = summarizeEconomics(this.economicRecords(network));
    const window = summarizeEconomics(
      this.economicRecords(network, reviewedThrough),
    );
    const inferred = window.some((g) => g.unknownCost > 0)
      ? "cost_unavailable"
      : window.some((g) => g.netResult !== null && BigInt(g.netResult) < 0n)
        ? "net_loss"
        : null;
    const reason = (control?.reason ?? inferred) as EconomicPauseReason | null;
    const audit = this.db
      .prepare(
        "SELECT * FROM economic_reviews WHERE network=? ORDER BY seq DESC LIMIT 20",
      )
      .all(network)
      .map((r) => ({
        at: String(r.at),
        actor: String(r.actor),
        reason: String(r.reason),
        throughSettlement: Number(r.through_seq),
        previousResult: JSON.parse(String(r.previous_result)) as unknown,
      }));
    return {
      version: Number(control?.version ?? 0),
      network,
      reviewedThrough,
      throughSettlement: Number(
        this.db
          .prepare(
            "SELECT MAX(seq) AS n FROM economic_settlements WHERE network=?",
          )
          .get(network)?.n ?? 0,
      ),
      blocked: control?.latched === 1 || inferred !== null,
      reason,
      pending: Number(
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM executions WHERE network=? AND status='pending'",
          )
          .get(network)?.n ?? 0,
      ),
      totals,
      window,
      lastReview: control?.reviewed_at
        ? {
            at: String(control.reviewed_at),
            actor: String(control.reviewed_by),
            reason: String(control.review_reason),
          }
        : null,
      audit,
      valuationBasis:
        "actual-native-fees-and-receipt-block-token-replacement-cost",
    };
  }
  latchEconomics(network: string, reason: EconomicPauseReason): void {
    z.enum(["mainnet", "fork"]).parse(network);
    const current = this.db
      .prepare("SELECT latched,reason FROM economic_controls WHERE network=?")
      .get(network);
    if (current?.latched === 1 && current.reason === reason) return;
    this.transaction(() => {
      this.touchEconomics(network);
      this.db
        .prepare(
          "UPDATE economic_controls SET latched=1,reason=? WHERE network=?",
        )
        .run(reason, network);
    });
  }
  /** Called only by the protected review path after fresh RPC canonicality checks. Never enables execution. */
  reviewEconomics(
    network: string,
    input: unknown,
    actor: string,
  ): EconomicsSnapshot {
    const change = economicsReviewSchema.parse(input);
    z.string().trim().min(1).max(120).parse(actor);
    return this.transaction(() => {
      const before = this.economics(network);
      if (
        before.version !== change.expectedVersion ||
        before.throughSettlement !== change.throughSettlement
      )
        throw Error(
          "Economics review version conflict; refresh before acknowledging",
        );
      if (before.pending > 0 || before.window.some((g) => g.unknownCost > 0))
        throw Error(
          "Pending transactions or unavailable fees must be reconciled before review",
        );
      const at = new Date().toISOString();
      this.touchEconomics(network);
      this.db
        .prepare(
          "UPDATE economic_controls SET reviewed_seq=?,latched=0,reason=NULL,reviewed_at=?,reviewed_by=?,review_reason=? WHERE network=?",
        )
        .run(before.throughSettlement, at, actor, change.reason, network);
      this.db
        .prepare(
          "INSERT INTO economic_reviews(network,through_seq,actor,reason,at,previous_result) VALUES(?,?,?,?,?,?)",
        )
        .run(
          network,
          before.throughSettlement,
          actor,
          change.reason,
          at,
          JSON.stringify({
            reason: before.reason,
            window: before.window,
            totals: before.totals,
          }),
        );
      return this.economics(network);
    });
  }
  list(input: HistoryQuery): HistoryPage {
    const q = historyQuerySchema.parse(input);
    const predicates = ["network=?"];
    const values: SQLInputValue[] = [q.network];
    if (q.chainId !== undefined) {
      predicates.push("chain_id=?");
      values.push(q.chainId);
    }
    if (q.poolId) {
      predicates.push("pool_id=?");
      values.push(q.poolId);
    }
    if (q.token) {
      predicates.push("(token_in=? OR token_out=?)");
      values.push(q.token, q.token);
    }
    if (q.status) {
      predicates.push("status=?");
      values.push(q.status);
    }
    if (q.from) {
      predicates.push("prepared_at>=?");
      values.push(q.from);
    }
    if (q.to) {
      predicates.push("prepared_at<=?");
      values.push(q.to);
    }
    const where = predicates.join(" AND ");
    const matchedCount = Number(
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM executions WHERE ${where}`)
        .get(...values)?.n ?? 0,
    );
    if (q.cursor) {
      let c: { seq: number; filter: string };
      try {
        c = JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8"));
      } catch {
        throw new Error("Invalid history cursor");
      }
      if (
        !c ||
        typeof c !== "object" ||
        !Number.isSafeInteger(c.seq) ||
        c.seq <= 0 ||
        c.filter !== fingerprint(q)
      )
        throw new Error("Invalid history cursor for filters");
      predicates.push("seq<?");
      values.push(c.seq);
    }
    const rows = this.db
      .prepare(
        `SELECT seq,payload FROM executions WHERE ${predicates.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...values, q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      version: 1,
      items: page.map((r) =>
        executionSchema.parse(JSON.parse(String(r.payload))),
      ),
      matchedCount,
      nextCursor:
        rows.length > q.limit && last
          ? Buffer.from(
              JSON.stringify({ seq: Number(last.seq), filter: fingerprint(q) }),
            ).toString("base64url")
          : null,
      generatedAt: new Date().toISOString(),
    };
  }
}
