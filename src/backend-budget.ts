import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Every Aqua0 backend request spends the backend's PAID RPC (a quote or search fans out into many
 * eth_calls). An unbounded block-driven loop once cost about $1000 in a few days, so each request
 * class has hard per-minute/hour/day caps that survive restarts. A refusal is a typed skip, never a
 * chain failure, so the worker idles instead of retrying harder.
 */
export type BackendCallClass = "catalog" | "search" | "authorize";
export type BudgetLimit = {
  perMinute: number;
  perHour: number;
  perDay: number;
};
export type BudgetLimits = Record<BackendCallClass, BudgetLimit>;

export class BackendBudgetExceeded extends Error {
  constructor(
    readonly callClass: BackendCallClass,
    readonly window: "minute" | "hour" | "day",
    readonly limit: number,
  ) {
    super(
      `Backend ${callClass} budget exhausted: ${limit} per ${window}. Waiting instead of calling the backend.`,
    );
  }
}

const MINUTE = 60_000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;
const CLASSES: BackendCallClass[] = ["catalog", "search", "authorize"];

type Stored = { version: 1; calls: Record<BackendCallClass, number[]> };

export class BackendBudget {
  private calls: Record<BackendCallClass, number[]> = {
    catalog: [],
    search: [],
    authorize: [],
  };
  private refused: Record<BackendCallClass, number> = {
    catalog: 0,
    search: 0,
    authorize: 0,
  };
  constructor(
    private readonly limits: BudgetLimits,
    private readonly path?: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!path) return;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // A corrupt ledger must not silently reset the budget to zero spent.
    const stored = JSON.parse(raw) as Stored;
    if (stored.version !== 1) throw new Error("Unknown backend budget ledger");
    for (const c of CLASSES) {
      const list = stored.calls?.[c];
      if (!Array.isArray(list) || list.some((t) => !Number.isFinite(t)))
        throw new Error("Corrupt backend budget ledger");
      this.calls[c] = list;
    }
    this.prune();
  }
  private prune() {
    const cutoff = this.now() - DAY;
    for (const c of CLASSES)
      this.calls[c] = this.calls[c].filter((t) => t > cutoff);
  }
  private count(c: BackendCallClass, windowMs: number) {
    const cutoff = this.now() - windowMs;
    return this.calls[c].filter((t) => t > cutoff).length;
  }
  /** Reserve one request or throw BackendBudgetExceeded. Records before the request is sent. */
  take(c: BackendCallClass): void {
    this.prune();
    const limit = this.limits[c];
    for (const [window, ms, max] of [
      ["minute", MINUTE, limit.perMinute],
      ["hour", HOUR, limit.perHour],
      ["day", DAY, limit.perDay],
    ] as const)
      if (this.count(c, ms) >= max) {
        this.refused[c]++;
        throw new BackendBudgetExceeded(c, window, max);
      }
    this.calls[c].push(this.now());
    this.persist();
  }
  private persist() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ version: 1, calls: this.calls } satisfies Stored),
      { mode: 0o600 },
    );
    renameSync(tmp, this.path);
  }
  status() {
    this.prune();
    return Object.fromEntries(
      CLASSES.map((c) => [
        c,
        {
          lastMinute: this.count(c, MINUTE),
          lastHour: this.count(c, HOUR),
          lastDay: this.count(c, DAY),
          refusedThisProcess: this.refused[c],
          limits: this.limits[c],
        },
      ]),
    ) as Record<
      BackendCallClass,
      {
        lastMinute: number;
        lastHour: number;
        lastDay: number;
        refusedThisProcess: number;
        limits: BudgetLimit;
      }
    >;
  }
}

/** Conservative defaults applied to every configuration that does not set its own budget. */
export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  catalog: { perMinute: 2, perHour: 30, perDay: 200 },
  search: { perMinute: 6, perHour: 120, perDay: 600 },
  authorize: { perMinute: 2, perHour: 20, perDay: 60 },
};
