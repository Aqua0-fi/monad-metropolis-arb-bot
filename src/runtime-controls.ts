import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
export const runtimeChangeSchema = z
  .object({
    expectedVersion: z.number().int().safe().nonnegative(),
    scope: z.enum(["all", "chain"]),
    chainId: z.number().int().safe().positive().optional(),
    paused: z.boolean(),
  })
  .strict()
  .refine(
    (v) =>
      v.scope === "chain" ? v.chainId !== undefined : v.chainId === undefined,
    "Select either all chains or one chain",
  );
const storedSchema = z
  .object({
    version: z.number().int().safe().nonnegative(),
    paused: z.boolean(),
    pausedChains: z.array(z.number().int().safe().positive()).max(128),
    actor: z.string().max(120).nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type RuntimeControlState = z.infer<typeof storedSchema>;
/** Only pauses/resumes new checks and trades. Cannot deploy, fund or change execution permissions. */
export class RuntimeControls {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly network: "mainnet" | "fork",
    private readonly chains: readonly number[],
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw Error("Controls store cannot be a symlink");
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS runtime_controls(network TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runtime_control_audit(id INTEGER PRIMARY KEY,network TEXT NOT NULL,payload TEXT NOT NULL);",
    );
  }
  read(): RuntimeControlState {
    const row = this.db
      .prepare("SELECT payload FROM runtime_controls WHERE network=?")
      .get(this.network);
    return row
      ? storedSchema.parse(JSON.parse(String(row.payload)))
      : {
          version: 0,
          paused: false,
          pausedChains: [],
          actor: null,
          updatedAt: null,
        };
  }
  paused(chainId: number) {
    const state = this.read();
    return state.paused || state.pausedChains.includes(chainId);
  }
  change(raw: unknown, actor: string): RuntimeControlState {
    const input = runtimeChangeSchema.parse(raw);
    if (!actor || actor.length > 120) throw Error("Invalid operator identity");
    if (input.chainId !== undefined && !this.chains.includes(input.chainId))
      throw Error("Unknown chain");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.read();
      if (state.version !== input.expectedVersion)
        throw Error(
          "Control version conflict; settings changed, refresh before saving",
        );
      const pausedChains = new Set(state.pausedChains);
      if (input.scope === "chain") {
        if (input.paused) pausedChains.add(input.chainId!);
        else pausedChains.delete(input.chainId!);
      }
      const next = {
        ...state,
        version: state.version + 1,
        paused: input.scope === "all" ? input.paused : state.paused,
        pausedChains: [...pausedChains].sort((a, b) => a - b),
        actor,
        updatedAt: new Date().toISOString(),
      };
      const payload = JSON.stringify(next);
      this.db
        .prepare(
          "INSERT INTO runtime_controls VALUES (?,?) ON CONFLICT(network) DO UPDATE SET payload=excluded.payload",
        )
        .run(this.network, payload);
      this.db
        .prepare(
          "INSERT INTO runtime_control_audit(network,payload) VALUES (?,?)",
        )
        .run(this.network, payload);
      this.db.exec("COMMIT");
      return next;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
