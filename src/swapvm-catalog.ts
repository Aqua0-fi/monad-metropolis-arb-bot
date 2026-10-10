import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type ChainConfig, same } from "./config.js";
import { marketPolicyInput, type MarketPolicy } from "./market-catalog.js";
import {
  swapVMMarketSchema,
  validateSwapVMListing,
  type SwapVMMarket,
} from "./swapvm.js";
const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
export interface CatalogSwapVMMarket {
  market: SwapVMMarket;
  policy: MarketPolicy | null;
  present: boolean;
  firstSeen: string;
  lastSeen: string;
  blockers: string[];
  readyToQuote: boolean;
}

/** Separate stable-strategy namespace: a V4 pool approval cannot authorize a SwapVM order. */
export class SwapVMMarketCatalog {
  private db: DatabaseSync;
  constructor(
    path: string,
    readonly network: "mainnet" | "fork",
    private readonly chains: readonly ChainConfig[],
    private readonly clock = Date.now,
    readonly maxAgeMs = 600000,
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw new Error("SwapVM catalog cannot be a symlink");
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS aqua_catalog(network TEXT NOT NULL,chain_id INTEGER NOT NULL,strategy_id TEXT NOT NULL,record TEXT NOT NULL,present INTEGER NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,PRIMARY KEY(network,chain_id,strategy_id));
      CREATE TABLE IF NOT EXISTS aqua_discovery(network TEXT NOT NULL,chain_id INTEGER NOT NULL,checked_at TEXT NOT NULL,ok INTEGER NOT NULL,error TEXT,PRIMARY KEY(network,chain_id));
      CREATE TABLE IF NOT EXISTS aqua_policies(network TEXT NOT NULL,chain_id INTEGER NOT NULL,strategy_id TEXT NOT NULL,version INTEGER NOT NULL,policy TEXT NOT NULL,PRIMARY KEY(network,chain_id,strategy_id));
      CREATE TABLE IF NOT EXISTS aqua_policy_audit(id INTEGER PRIMARY KEY,network TEXT NOT NULL,chain_id INTEGER NOT NULL,strategy_id TEXT NOT NULL,version INTEGER NOT NULL,policy TEXT NOT NULL);`);
  }
  close() {
    this.db.close();
  }
  recordListing(chain: ChainConfig, raw: unknown) {
    const listing = validateSwapVMListing(chain, this.network, raw),
      now = new Date(this.clock()).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE aqua_catalog SET present=0 WHERE network=? AND chain_id=?",
        )
        .run(this.network, chain.chainId);
      for (const market of listing.markets) {
        this.db
          .prepare(
            "INSERT INTO aqua_catalog VALUES (?,?,?,?,1,?,?) ON CONFLICT(network,chain_id,strategy_id) DO UPDATE SET record=excluded.record,present=1,last_seen=excluded.last_seen",
          )
          .run(
            this.network,
            chain.chainId,
            market.stableStrategyId.toLowerCase(),
            json(market),
            now,
            now,
          );
      }
      this.db
        .prepare(
          "INSERT INTO aqua_discovery VALUES (?,?,?,1,?) ON CONFLICT(network,chain_id) DO UPDATE SET checked_at=excluded.checked_at,ok=1,error=excluded.error",
        )
        .run(
          this.network,
          chain.chainId,
          now,
          listing.unavailable.length
            ? `${listing.unavailable.length} strategies could not be verified; they are not enabled`
            : null,
        );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  recordFailure(chainId: number) {
    if (!this.chains.some((chain) => chain.chainId === chainId))
      throw new Error("Unknown SwapVM discovery chain");
    this.db
      .prepare(
        "INSERT INTO aqua_discovery VALUES (?,?,?,0,?) ON CONFLICT(network,chain_id) DO UPDATE SET checked_at=excluded.checked_at,ok=0,error=excluded.error",
      )
      .run(
        this.network,
        chainId,
        new Date(this.clock()).toISOString(),
        "SwapVM discovery is unavailable; last records are not tradable",
      );
  }
  list() {
    const runs = this.db
      .prepare("SELECT * FROM aqua_discovery WHERE network=?")
      .all(this.network);
    const rows = this.db
      .prepare(
        "SELECT c.*,p.policy FROM aqua_catalog c LEFT JOIN aqua_policies p ON p.network=c.network AND p.chain_id=c.chain_id AND p.strategy_id=c.strategy_id WHERE c.network=? ORDER BY c.chain_id,c.strategy_id",
      )
      .all(this.network);
    const markets: CatalogSwapVMMarket[] = rows.map((row) => {
      const market = swapVMMarketSchema.parse(JSON.parse(String(row.record)));
      const policy: MarketPolicy | null = row.policy
        ? JSON.parse(String(row.policy))
        : null;
      const chain = this.chains.find((c) => c.chainId === market.chainId);
      const run = runs.find((r) => r.chain_id === market.chainId);
      const blockers: string[] = [];
      if (!row.present)
        blockers.push(
          "The strategy is not currently verified in the discovery feed",
        );
      if (!run?.ok) blockers.push("SwapVM discovery is unavailable");
      const age = this.clock() - Date.parse(String(row.last_seen));
      if (age > this.maxAgeMs || age < -1000)
        blockers.push("SwapVM discovery is stale");
      if (!chain?.executionReviewed || chain.feeModel === "unsupported")
        blockers.push("Chain execution/fee capability is not reviewed");
      if (!chain?.venues.length)
        blockers.push("No supported external V3 venue configured");
      if (policy && BigInt(policy.classId) !== market.classId)
        blockers.push("The approved strategy class changed");
      return {
        market,
        policy,
        present: row.present === 1,
        firstSeen: String(row.first_seen),
        lastSeen: String(row.last_seen),
        blockers,
        readyToQuote: blockers.length === 0 && policy?.approved === true,
      };
    });
    return {
      version: 1 as const,
      venue: "aqua" as const,
      network: this.network,
      generatedAt: new Date(this.clock()).toISOString(),
      executionActivationSupported: false as const,
      markets,
    };
  }
  setPolicy(
    chainId: number,
    strategyId: string,
    raw: unknown,
    actor: string,
  ): MarketPolicy {
    const input = marketPolicyInput.parse(raw);
    if (!actor || actor.length > 120) throw new Error("Invalid policy actor");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.list().markets.find(
        (m) =>
          m.market.chainId === chainId &&
          same(m.market.stableStrategyId, strategyId),
      );
      if (!current) throw new Error("Unknown discovered SwapVM strategy");
      const version = current.policy?.version ?? 0;
      if (input.expectedVersion !== version)
        throw new Error("Policy version conflict; refresh before editing");
      if (
        ![current.market.token0, current.market.token1].some((t) =>
          same(t, input.baseToken),
        )
      )
        throw new Error("Starting token is outside the strategy pair");
      if (
        input.approved &&
        (current.blockers.length ||
          current.market.classId !== BigInt(input.classId))
      )
        throw new Error("Current SwapVM strategy is not eligible for approval");
      const { expectedVersion: _, ...body } = input;
      const policy = {
        ...body,
        version: version + 1,
        actor,
        updatedAt: new Date(this.clock()).toISOString(),
      };
      this.db
        .prepare(
          "INSERT INTO aqua_policies VALUES (?,?,?,?,?) ON CONFLICT(network,chain_id,strategy_id) DO UPDATE SET version=excluded.version,policy=excluded.policy",
        )
        .run(
          this.network,
          chainId,
          strategyId.toLowerCase(),
          policy.version,
          json(policy),
        );
      this.db
        .prepare(
          "INSERT INTO aqua_policy_audit(network,chain_id,strategy_id,version,policy) VALUES (?,?,?,?,?)",
        )
        .run(
          this.network,
          chainId,
          strategyId.toLowerCase(),
          policy.version,
          json(policy),
        );
      this.db.exec("COMMIT");
      return policy;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  assertApproved(market: SwapVMMarket, policy: MarketPolicy) {
    const current = this.list().markets.find(
      (m) =>
        m.market.chainId === market.chainId &&
        same(m.market.stableStrategyId, market.stableStrategyId),
    );
    if (!current?.readyToQuote || current.policy?.version !== policy.version)
      throw new Error(
        "SwapVM strategy was paused, changed or became unavailable",
      );
  }
}
