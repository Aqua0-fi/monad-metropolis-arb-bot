import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import { z } from "zod";
import {
  address,
  poolSchema,
  same,
  type ChainConfig,
  type Market,
  type Pool,
} from "./config.js";
import { registryBlockers } from "./registry.js";

const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(78)
  .refine((v) => BigInt(v) < 1n << 256n, "Integer exceeds uint256");
const positive = uint.refine((v) => BigInt(v) > 0n, "Amount must be positive");
const tokenMeta = z
  .object({
    symbol: z.string().max(40).optional(),
    decimals: z.number().int().min(0).max(36).optional(),
  })
  .passthrough();
const listedPool = poolSchema.extend({
  poolManager: address,
  isAqua0Enabled: z.boolean().optional(),
  armedOnCurrentAdapter: z.boolean().nullable().optional(),
  sqrtPriceX96: uint.optional(),
  token0: tokenMeta.nullable().optional(),
  token1: tokenMeta.nullable().optional(),
  aquaClass: z
    .object({
      classId: positive.nullable().optional(),
      paused: z.boolean().nullable().optional(),
      otherClassIds: z.array(positive).max(128).optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
});
export interface DiscoveredPool {
  pool: Pool;
  chainId: number;
  classIds: string[];
  armed: boolean | null;
  tokens: { address: string; symbol: string | null; decimals: number | null }[];
  blockers: string[];
}
export const marketPolicyInput = z
  .object({
    expectedVersion: z.number().int().safe().nonnegative(),
    approved: z.boolean(),
    classId: positive,
    baseToken: address,
    amounts: z.array(positive).max(8).default([]),
    maxInput: positive,
    minNetProfit: positive,
    note: z.string().max(1000).default(""),
  })
  .strict()
  .refine(
    (v) => v.amounts.every((n) => BigInt(n) <= BigInt(v.maxInput)),
    "Sample size exceeds maximum input",
  );
export type MarketPolicy = Omit<
  z.infer<typeof marketPolicyInput>,
  "expectedVersion"
> & { version: number; actor: string; updatedAt: string };
export interface CatalogMarket extends DiscoveredPool {
  present: boolean;
  firstSeen: string;
  lastSeen: string;
  policy: MarketPolicy | null;
  readyToQuote: boolean;
}
interface CatalogRow {
  record: string;
  present: number;
  first_seen: string;
  last_seen: string;
  policy: string | null;
}
interface RunRow {
  chain_id: number;
  checked_at: string;
  ok: number;
  error: string | null;
}

/** Ordinary read-tier data is a discovery hint; identity is recomputed and no policy is inferred. */
export function validatePoolListing(
  chain: ChainConfig,
  raw: unknown,
): DiscoveredPool[] {
  const listing = z
    .object({
      chainId: z.number().int(),
      rpcDegraded: z.boolean(),
      pools: z.array(listedPool).max(1000),
    })
    .parse(raw);
  if (listing.chainId !== chain.chainId)
    throw new Error("Public pool listing chain mismatch");
  if (listing.rpcDegraded)
    throw new Error("Public pool listing is partial or RPC-degraded");
  const seen = new Set<string>();
  return listing.pools.map((p) => {
    const id = keccak256(
      encodeAbiParameters(
        parseAbiParameters("address,address,uint24,int24,address"),
        [p.currency0, p.currency1, p.fee, p.tickSpacing, p.hooks],
      ),
    );
    if (
      !same(id, p.poolId) ||
      !same(p.hooks, chain.aqua0Hook) ||
      !same(p.poolManager, chain.poolManager) ||
      BigInt(p.currency0) === 0n ||
      BigInt(p.currency0) >= BigInt(p.currency1)
    )
      throw new Error(
        "Public pool listing key, token order or deployment mismatch",
      );
    if (seen.has(id)) throw new Error("Duplicate public pool identity");
    seen.add(id);
    const pool = poolSchema.parse(p);
    const blockers = registryBlockers({ ...chain, pools: [pool] });
    if (p.armedOnCurrentAdapter !== true)
      blockers.push(
        p.armedOnCurrentAdapter === false
          ? "Pool is not armed on the current adapter"
          : "Pool arming is unknown",
      );
    if (p.isAqua0Enabled === false)
      blockers.push("Pool is disabled in the public listing");
    if (!p.sqrtPriceX96 || BigInt(p.sqrtPriceX96) === 0n)
      blockers.push("Pool initialization is not verified");
    if (p.fee >= 1_000_000)
      blockers.push("Pool fee is unsupported for this worker");
    const classIds = [
      ...new Set([
        ...(p.aquaClass?.classId ? [p.aquaClass.classId] : []),
        ...(p.aquaClass?.otherClassIds ?? []),
      ]),
    ];
    if (!classIds.length)
      blockers.push("No class identity resolved on the public listing");
    if (p.aquaClass?.paused === true)
      blockers.push("The listed class is paused");
    return {
      pool,
      chainId: chain.chainId,
      classIds,
      armed: p.armedOnCurrentAdapter ?? null,
      blockers,
      tokens: [
        {
          address: p.currency0,
          symbol: p.token0?.symbol ?? null,
          decimals: p.token0?.decimals ?? null,
        },
        {
          address: p.currency1,
          symbol: p.token1?.symbol ?? null,
          decimals: p.token1?.decimals ?? null,
        },
      ],
    };
  });
}

export class MarketCatalog {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly network: "mainnet" | "fork",
    private readonly chains: readonly ChainConfig[],
    private readonly clock: () => number = Date.now,
    readonly maxAgeMs = 600000,
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw new Error("Catalog cannot be a symlink");
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS market_catalog(network TEXT NOT NULL, chain_id INTEGER NOT NULL, pool_id TEXT NOT NULL, record TEXT NOT NULL, present INTEGER NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY(network,chain_id,pool_id));
      CREATE TABLE IF NOT EXISTS market_discovery_runs(network TEXT NOT NULL, chain_id INTEGER NOT NULL, checked_at TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT, PRIMARY KEY(network,chain_id));
      CREATE TABLE IF NOT EXISTS market_policies(network TEXT NOT NULL, chain_id INTEGER NOT NULL, pool_id TEXT NOT NULL, version INTEGER NOT NULL, policy TEXT NOT NULL, PRIMARY KEY(network,chain_id,pool_id));
      CREATE TABLE IF NOT EXISTS market_policy_audit(id INTEGER PRIMARY KEY, network TEXT NOT NULL, chain_id INTEGER NOT NULL, pool_id TEXT NOT NULL, version INTEGER NOT NULL, policy TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  close() {
    this.db.close();
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  recordListing(chain: ChainConfig, raw: unknown): void {
    const pools = validatePoolListing(chain, raw),
      now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE market_catalog SET present=0 WHERE network=? AND chain_id=?",
        )
        .run(this.network, chain.chainId);
      for (const record of pools)
        this.db
          .prepare(
            "INSERT INTO market_catalog VALUES (?,?,?,?,1,?,?) ON CONFLICT(network,chain_id,pool_id) DO UPDATE SET record=excluded.record,present=1,last_seen=excluded.last_seen",
          )
          .run(
            this.network,
            chain.chainId,
            record.pool.poolId.toLowerCase(),
            JSON.stringify(record),
            now,
            now,
          );
      this.db
        .prepare(
          "INSERT INTO market_discovery_runs VALUES (?,?,?,1,NULL) ON CONFLICT(network,chain_id) DO UPDATE SET checked_at=excluded.checked_at,ok=1,error=NULL",
        )
        .run(this.network, chain.chainId, now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  recordFailure(chainId: number, message: string): void {
    if (!this.chains.some((c) => c.chainId === chainId))
      throw new Error("Unknown discovery chain");
    const safe = message
      .replace(/https?:\/\/\S+/g, "[endpoint]")
      .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, "[credential]")
      .slice(0, 240);
    this.db
      .prepare(
        "INSERT INTO market_discovery_runs VALUES (?,?,?,0,?) ON CONFLICT(network,chain_id) DO UPDATE SET checked_at=excluded.checked_at,ok=0,error=excluded.error",
      )
      .run(this.network, chainId, this.now(), safe);
  }
  list(): {
    version: 1;
    network: string;
    generatedAt: string;
    executionActivationSupported: false;
    markets: CatalogMarket[];
    chains: {
      chainId: number;
      name: string;
      checkedAt: string | null;
      ok: boolean;
      error: string | null;
    }[];
  } {
    const runs = this.db
      .prepare(
        "SELECT chain_id,checked_at,ok,error FROM market_discovery_runs WHERE network=?",
      )
      .all(this.network) as unknown as RunRow[];
    const rows = this.db
      .prepare(
        "SELECT c.*,p.policy FROM market_catalog c LEFT JOIN market_policies p ON p.network=c.network AND p.chain_id=c.chain_id AND p.pool_id=c.pool_id WHERE c.network=? ORDER BY c.chain_id,c.pool_id",
      )
      .all(this.network) as unknown as CatalogRow[];
    const markets = rows.map((row): CatalogMarket => {
      const record = JSON.parse(row.record) as DiscoveredPool,
        policy = row.policy ? (JSON.parse(row.policy) as MarketPolicy) : null;
      const run = runs.find((r) => r.chain_id === record.chainId);
      const blockers = [...record.blockers];
      if (!row.present)
        blockers.push("Pool no longer appears in the public listing");
      if (!run?.ok) blockers.push(run?.error ?? "Discovery has not completed");
      if (
        this.clock() - Date.parse(row.last_seen) > this.maxAgeMs ||
        Date.parse(row.last_seen) > this.clock() + 1000
      )
        blockers.push("Discovery is stale");
      if (policy && !record.classIds.includes(policy.classId))
        blockers.push("Approved class is no longer in the public listing");
      return {
        ...record,
        blockers,
        present: row.present === 1,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        policy,
        readyToQuote: blockers.length === 0 && policy?.approved === true,
      };
    });
    return {
      version: 1,
      network: this.network,
      generatedAt: this.now(),
      executionActivationSupported: false,
      markets,
      chains: this.chains.map((c) => {
        const run = runs.find((r) => r.chain_id === c.chainId);
        return {
          chainId: c.chainId,
          name: c.name,
          checkedAt: run?.checked_at ?? null,
          ok:
            run?.ok === 1 &&
            this.clock() - Date.parse(run.checked_at) <= this.maxAgeMs,
          error: run?.error ?? null,
        };
      }),
    };
  }
  setPolicy(
    chainId: number,
    poolId: string,
    raw: unknown,
    actor: string,
  ): MarketPolicy {
    const input = marketPolicyInput.parse(raw);
    if (!actor || actor.length > 120) throw new Error("Invalid policy actor");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const market = this.list().markets.find(
        (r) => r.chainId === chainId && same(r.pool.poolId, poolId),
      );
      if (!market) throw new Error("Unknown discovered market");
      const currentVersion = market.policy?.version ?? 0;
      if (currentVersion !== input.expectedVersion)
        throw new Error("Policy version conflict; refresh before editing");
      if (
        !same(input.baseToken, market.pool.currency0) &&
        !same(input.baseToken, market.pool.currency1)
      )
        throw new Error("Policy base asset is not in the discovered pair");
      if (input.approved) {
        if (!market.classIds.includes(input.classId))
          throw new Error("Policy class is not in the public listing");
        if (market.blockers.length)
          throw new Error(
            `Market cannot be approved: ${market.blockers.join("; ")}`,
          );
      }
      const { expectedVersion: _, ...body } = input;
      const policy: MarketPolicy = {
        ...body,
        version: currentVersion + 1,
        actor,
        updatedAt: this.now(),
      };
      this.db
        .prepare(
          "INSERT INTO market_policies VALUES (?,?,?,?,?) ON CONFLICT(network,chain_id,pool_id) DO UPDATE SET version=excluded.version,policy=excluded.policy",
        )
        .run(
          this.network,
          chainId,
          poolId.toLowerCase(),
          policy.version,
          JSON.stringify(policy),
        );
      this.db
        .prepare(
          "INSERT INTO market_policy_audit(network,chain_id,pool_id,version,policy,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          this.network,
          chainId,
          poolId.toLowerCase(),
          policy.version,
          JSON.stringify(policy),
          policy.updatedAt,
        );
      this.db.exec("COMMIT");
      return policy;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  audit(chainId: number, poolId: string): MarketPolicy[] {
    return this.db
      .prepare(
        "SELECT policy FROM market_policy_audit WHERE network=? AND chain_id=? AND pool_id=? ORDER BY id DESC LIMIT 50",
      )
      .all(this.network, chainId, poolId.toLowerCase())
      .map((r) => JSON.parse(String(r.policy)) as MarketPolicy);
  }
  activeMarkets(): Market[] {
    return this.list()
      .markets.filter((m) => m.readyToQuote)
      .map((m) => ({
        chainId: m.chainId,
        poolId: m.pool.poolId,
        classId: BigInt(m.policy!.classId),
        baseToken: m.policy!.baseToken,
        amounts: (m.policy!.amounts ?? []).map(BigInt),
        maxInput: BigInt(m.policy!.maxInput),
        minNetProfit: BigInt(m.policy!.minNetProfit),
      }));
  }
  activePools(chainId: number): Pool[] {
    return this.list()
      .markets.filter((m) => m.chainId === chainId && m.readyToQuote)
      .map((m) => m.pool);
  }
}
