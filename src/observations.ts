import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  opportunitySchema,
  balanceObservationSchema,
  observationQuerySchema,
  opportunityState,
  type ObservationQuery,
  type OpportunityRecord,
  type BalanceObservation,
  type OpportunityPage,
  type BalancePage,
  type ObservationCoverage,
} from "./observation-wire.js";

type Kind = "opportunities" | "balances";
const updateSchema = z
  .object({
    executionAmountIn: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .max(80)
      .nullable()
      .optional(),
    state: opportunityState.optional(),
    reason: z.string().max(400).nullable().optional(),
    estimatedFee: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .max(80)
      .nullable()
      .optional(),
    estimatedNet: z
      .string()
      .regex(/^-?(0|[1-9][0-9]*)$/)
      .max(81)
      .nullable()
      .optional(),
    transactionHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .transform((s) => s.toLowerCase())
      .nullable()
      .optional(),
    executionTradeId: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .transform((s) => s.toLowerCase())
      .nullable()
      .optional(),
  })
  .strict();
export type OpportunityUpdate = z.input<typeof updateSchema>;
const cursorSchema = z
  .object({
    signature: z.string().length(64),
    before: z.number().int().positive().safe(),
    upper: z.number().int().nonnegative().safe(),
  })
  .strict();

/** Observation telemetry only. Authoritative transactions, gas accounting and permissions live elsewhere. */
export class ObservationStore {
  private db: DatabaseSync;
  constructor(
    path: string,
    private readonly clock = Date.now,
    private readonly maxRecords = 200000,
  ) {
    if (
      !Number.isSafeInteger(maxRecords) ||
      maxRecords < 1 ||
      maxRecords > 1000000
    )
      throw Error("Invalid observation retention limit");
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw Error("Observation database must not be a symlink");
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=25;
   CREATE TABLE IF NOT EXISTS observation_meta(kind TEXT NOT NULL,network TEXT NOT NULL,started_at TEXT NOT NULL,removed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,network));
   CREATE TABLE IF NOT EXISTS opportunities(sequence INTEGER PRIMARY KEY AUTOINCREMENT,network TEXT NOT NULL,chain_id INTEGER NOT NULL,id TEXT NOT NULL,at TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(network,chain_id,id));
   CREATE INDEX IF NOT EXISTS opportunities_filter ON opportunities(network,chain_id,state,sequence);
   CREATE TABLE IF NOT EXISTS balances(sequence INTEGER PRIMARY KEY AUTOINCREMENT,network TEXT NOT NULL,chain_id INTEGER NOT NULL,role TEXT NOT NULL,wallet TEXT NOT NULL,asset TEXT NOT NULL,at TEXT NOT NULL,payload TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS balances_filter ON balances(network,chain_id,role,wallet,asset,sequence);
  `);
    // There was no persisted transaction linkage for these unfinished passes. Never call them successful.
    this.db
      .prepare(
        `UPDATE opportunities SET state='interrupted',payload=json_set(payload,'$.state','interrupted','$.reason','Worker restarted before this observation received a final outcome','$.updatedAt',?) WHERE state IN ('found','rechecking')`,
      )
      .run(this.time());
  }
  close() {
    this.db.close();
  }
  /** Persist the coverage start even when the process has not found any candidate yet. */
  begin(network: "mainnet" | "fork") {
    this.transact(() => {
      this.metadata("opportunities", network);
      this.metadata("balances", network);
    });
  }
  private time() {
    return new Date(this.clock()).toISOString();
  }
  private transact<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private metadata(kind: Kind, network: string) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO observation_meta(kind,network,started_at) VALUES(?,?,?)",
      )
      .run(kind, network, this.time());
  }
  private prune(kind: Kind, network: string) {
    const count = Number(
      this.db
        .prepare(`SELECT COUNT(*) n FROM ${kind} WHERE network=?`)
        .get(network)?.n ?? 0,
    );
    const remove = count - this.maxRecords;
    if (remove <= 0) return;
    this.db
      .prepare(
        `DELETE FROM ${kind} WHERE sequence IN (SELECT sequence FROM ${kind} WHERE network=? ORDER BY sequence LIMIT ?)`,
      )
      .run(network, remove);
    this.db
      .prepare(
        "UPDATE observation_meta SET removed=removed+? WHERE kind=? AND network=?",
      )
      .run(remove, kind, network);
  }
  found(raw: unknown) {
    const record = opportunitySchema.parse(raw);
    if (
      record.state !== "found" ||
      record.transactionHash !== null ||
      record.executionTradeId !== null
    )
      throw Error("New observations must begin as unsigned found candidates");
    this.transact(() => {
      this.metadata("opportunities", record.network);
      const previous = this.db
        .prepare(
          "SELECT payload FROM opportunities WHERE network=? AND chain_id=? AND id=?",
        )
        .get(record.network, record.chainId, record.id);
      if (previous) {
        const old = opportunitySchema.parse(
          JSON.parse(String(previous.payload)),
        );
        for (const key of [
          "marketId",
          "classId",
          "venue",
          "caller",
          "otherToken",
          "aquaFirst",
          "quoteBlock",
          "amountIn",
          "baseToken",
          "externalPool",
          "quoteBlockHash",
        ] as const)
          if (old[key] !== record[key])
            throw Error("An opportunity ID cannot be reused for another quote");
        return;
      }
      this.db
        .prepare(
          "INSERT INTO opportunities(network,chain_id,id,at,state,payload) VALUES(?,?,?,?,?,?)",
        )
        .run(
          record.network,
          record.chainId,
          record.id,
          record.foundAt,
          record.state,
          JSON.stringify(record),
        );
      this.prune("opportunities", record.network);
    });
  }
  update(
    network: "mainnet" | "fork",
    chainId: number,
    id: string,
    raw: OpportunityUpdate,
  ) {
    const change = updateSchema.parse(raw);
    this.transact(() => {
      const row = this.db
        .prepare(
          "SELECT payload FROM opportunities WHERE network=? AND chain_id=? AND id=?",
        )
        .get(network, chainId, id.toLowerCase());
      if (!row) throw Error("Unknown observed opportunity");
      const old = opportunitySchema.parse(JSON.parse(String(row.payload)));
      if (
        old.transactionHash !== null &&
        ((change.state &&
          !(["transaction-prepared", "submitted"] as string[]).includes(
            change.state,
          )) ||
          (change.transactionHash !== undefined &&
            change.transactionHash !== old.transactionHash) ||
          (change.executionTradeId !== undefined &&
            change.executionTradeId !== old.executionTradeId) ||
          (change.executionAmountIn !== undefined &&
            old.executionAmountIn !== null &&
            change.executionAmountIn !== old.executionAmountIn) ||
          (old.state === "submitted" &&
            change.state === "transaction-prepared"))
      )
        throw Error(
          "A submitted observation cannot be rewritten as a rejected quote",
        );
      const next = opportunitySchema.parse({
        ...old,
        ...change,
        updatedAt: this.time(),
      });
      if (
        ["transaction-prepared", "submitted"].includes(next.state) &&
        (!next.transactionHash || !next.executionTradeId)
      )
        throw Error(
          "Submitted observations require the actual transaction and execution identities",
        );
      this.db
        .prepare(
          "UPDATE opportunities SET state=?,payload=? WHERE network=? AND chain_id=? AND id=?",
        )
        .run(
          next.state,
          JSON.stringify(next),
          network,
          chainId,
          id.toLowerCase(),
        );
    });
  }
  finishFound(
    network: "mainnet" | "fork",
    chainId: number,
    ids: string[],
    mode: "observe" | "execute",
  ) {
    const state = mode === "observe" ? "observed" : "not-selected";
    const reason =
      mode === "observe"
        ? "Observation only; execution was not enabled for this pass"
        : "Another candidate was selected or this scan ended before selection";
    this.transact(() => {
      const update = this.db.prepare(
        "UPDATE opportunities SET state=?,payload=json_set(payload,'$.state',?,'$.reason',?,'$.updatedAt',?) WHERE network=? AND chain_id=? AND id=? AND state='found'",
      );
      for (const id of ids)
        update.run(
          state,
          state,
          reason,
          this.time(),
          network,
          chainId,
          id.toLowerCase(),
        );
    });
  }
  balance(raw: unknown) {
    const row = balanceObservationSchema.parse(raw);
    this.transact(() => {
      this.metadata("balances", row.network);
      this.db
        .prepare(
          "INSERT INTO balances(network,chain_id,role,wallet,asset,at,payload) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          row.network,
          row.chainId,
          row.role,
          row.wallet,
          row.asset ?? "native",
          row.observedAt,
          JSON.stringify(row),
        );
      this.prune("balances", row.network);
    });
  }
  private coverage(kind: Kind, network: string): ObservationCoverage {
    const row = this.db
      .prepare("SELECT * FROM observation_meta WHERE kind=? AND network=?")
      .get(kind, network);
    const range = this.db
      .prepare(`SELECT MIN(at) first,MAX(at) last FROM ${kind} WHERE network=?`)
      .get(network);
    return {
      startedAt: String(row?.started_at ?? this.time()),
      oldestRetainedAt: range?.first ? String(range.first) : null,
      newestRetainedAt: range?.last ? String(range.last) : null,
      removedRecords: Number(row?.removed ?? 0),
      retainedLimit: this.maxRecords,
      note:
        kind === "opportunities"
          ? "Recorded candidates since observation history was enabled. Earlier logs are not reconstructed; a quote is not a trade or a realized profit."
          : "Actual sampled balances. Missing reads are gaps, not zero. A balance change can include funding, withdrawals or fees and is not by itself trading profit.",
    };
  }
  private page(kind: Kind, raw: ObservationQuery) {
    const q = observationQuerySchema.parse(raw);
    if (
      (kind === "opportunities" && (q.role || q.wallet || q.asset)) ||
      (kind === "balances" && q.state)
    )
      throw Error("Filters do not belong to this observation type");
    const { cursor, limit, ...filters } = q;
    const signature = createHash("sha256")
      .update(JSON.stringify({ kind, ...filters }))
      .digest("hex");
    const clauses = ["network= ?"],
      values: SQLInputValue[] = [q.network];
    if (q.chainId !== undefined) {
      clauses.push("chain_id=?");
      values.push(q.chainId);
    }
    for (const [column, value] of [
      ["at>=", q.from],
      ["at<=", q.to],
    ] as const)
      if (value !== undefined) {
        clauses.push(column + "?");
        values.push(value);
      }
    for (const [column, value] of [
      ["state", q.state],
      ["role", q.role],
      ["wallet", q.wallet],
      ["asset", q.asset],
    ] as const)
      if (value !== undefined) {
        clauses.push(column + "=?");
        values.push(value);
      }
    let upper = Number(
        this.db
          .prepare(
            `SELECT MAX(sequence) n FROM ${kind} WHERE ${clauses.join(" AND ")}`,
          )
          .get(...values)?.n ?? 0,
      ),
      before = Number.MAX_SAFE_INTEGER;
    if (cursor) {
      try {
        const c = cursorSchema.parse(
          JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
        );
        if (c.signature !== signature || c.before > c.upper + 1) throw Error();
        upper = c.upper;
        before = c.before;
      } catch {
        throw Error("Invalid observation cursor for these filters");
      }
    }
    const where = clauses.join(" AND ") + " AND sequence<=?";
    const matchedCount = Number(
      this.db
        .prepare(`SELECT COUNT(*) n FROM ${kind} WHERE ${where}`)
        .get(...values, upper)?.n ?? 0,
    );
    const rows = this.db
      .prepare(
        `SELECT sequence,payload FROM ${kind} WHERE ${where} AND sequence<? ORDER BY sequence DESC LIMIT ?`,
      )
      .all(...values, upper, before, limit + 1);
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => ({
      sequence: Number(r.sequence),
      ...JSON.parse(String(r.payload)),
    }));
    const nextCursor =
      more && items.length
        ? Buffer.from(
            JSON.stringify({
              signature,
              upper,
              before: items.at(-1)!.sequence,
            }),
          ).toString("base64url")
        : null;
    return {
      version: 1 as const,
      network: q.network,
      generatedAt: this.time(),
      items,
      matchedCount,
      nextCursor,
      coverage: this.coverage(kind, q.network),
    };
  }
  opportunities(query: ObservationQuery): OpportunityPage {
    return this.page("opportunities", query);
  }
  balances(query: ObservationQuery): BalancePage {
    const q = observationQuerySchema.parse(query);
    const page = this.page("balances", query);
    const clauses = ["network=?"],
      values: SQLInputValue[] = [q.network];
    for (const [column, value] of [
      ["chain_id", q.chainId],
      ["role", q.role],
      ["wallet", q.wallet],
      ["asset", q.asset],
    ] as const) {
      if (value !== undefined) {
        clauses.push(column + "=?");
        values.push(value);
      }
    }
    if (q.from !== undefined) {
      clauses.push("at>=?");
      values.push(q.from);
    }
    if (q.to !== undefined) {
      clauses.push("at<=?");
      values.push(q.to);
    }
    const rows = this.db
      .prepare(
        `SELECT sequence,payload FROM balances WHERE sequence IN (SELECT MAX(sequence) FROM balances WHERE ${clauses.join(" AND ")} GROUP BY chain_id,role,wallet,asset) ORDER BY role,chain_id,asset LIMIT 129`,
      )
      .all(...values);
    const series = rows.slice(0, 128).map((r) => ({
      sequence: Number(r.sequence),
      ...balanceObservationSchema.parse(JSON.parse(String(r.payload))),
    }));
    return { ...page, series, seriesTruncated: rows.length > 128 };
  }
}
