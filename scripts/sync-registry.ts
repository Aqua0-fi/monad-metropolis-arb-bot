/** Run with Bun and an explicit current backend checkout. Runtime/Docker uses only generated JSON. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  buildChainRegistry,
  canonicalChainSchema,
  executionPolicySchema,
} from "../src/registry.js";

const sourceRoot = process.argv[2];
if (!sourceRoot)
  throw new Error(
    "Usage: bun scripts/sync-registry.ts /absolute/path/to/backend [--check]",
  );
const root = resolve(sourceRoot);
if (process.env.DEPLOYMENT_JSON_DIR)
  throw new Error(
    "Unset DEPLOYMENT_JSON_DIR so the explicit checkout is the source",
  );
const registry: Record<string, (...args: any[]) => any> = await import(
  pathToFileURL(resolve(root, "packages/registry/src/index.ts")).href
);
const { opcodeMapForRouter } = await import(
  pathToFileURL(
    resolve(root, "packages/api/src/services/strategy-builder.service.ts"),
  ).href
);
function swapVMDeployment(d: any, chainId: number) {
  const configured = d.vaultFleet?.external?.swapVMRouter;
  if (!configured || /^0x0{40}$/i.test(configured)) return undefined;
  const router = registry.getFleetSwapVMRouterAddress!(chainId);
  const header = opcodeMapForRouter(router)?.takerHeaderBytes;
  if (header !== 20 && header !== 22)
    throw new Error(`Unrecognized SwapVM build on ${chainId}`);
  return {
    router,
    aqua: registry.getAquaRouterAddress!(chainId),
    maker: registry.getAquaAdapterAddress!(chainId),
    slices: (header - 2) / 2,
  };
}
const source = registry.allChains!()
  .filter(
    (c: { launched: boolean; testnet: boolean }) => c.launched && !c.testnet,
  )
  .map((c: any) => {
    const d = registry.loadDeployment!(c.id);
    const vaults = Object.entries(d.vaultFleet?.vaults ?? {}) as [
      string,
      any,
    ][];
    return canonicalChainSchema.parse({
      chainId: c.id,
      name: c.name,
      rpcEnv: c.rpcEnvVar,
      nativeCurrency: c.nativeCurrency,
      poolManager: registry.getPoolManagerAddress!(c.id),
      universalRouter: registry.getUniversalRouterAddress!(c.id),
      permit2: registry.getChainExternals!(c.id)?.permit2,
      aqua0Hook: registry.getV4AdapterAddress!(c.id),
      swapVM: swapVMDeployment(d, c.id),
      pools: registry.getFleetPools!(c.id),
      tokens: vaults
        .filter(([, v]) => v && typeof v === "object" && v.asset)
        .map(([symbol, v]) => ({
          symbol: v.symbol ?? symbol,
          address: v.asset,
          decimals: v.decimals,
        })),
    });
  });
const policies = z
  .record(z.string(), executionPolicySchema)
  .parse(JSON.parse(readFileSync("config/execution-policies.json", "utf8")));
const rows = buildChainRegistry(source, policies);
const rendered = JSON.stringify({ chains: rows }, null, 2) + "\n";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
if (process.argv.includes("--check")) {
  if (readFileSync("config/chains.json", "utf8") !== rendered)
    throw new Error("Generated registry is stale");
  console.log(`Canonical registry matches: ${rows.length} launched chains`);
} else {
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  writeFileSync("config/chains.json", rendered);
  writeFileSync(
    "config/registry-provenance.json",
    JSON.stringify(
      {
        backendCommit: commit,
        canonicalRecordsSha256: hash(JSON.stringify(source)),
        executionPoliciesSha256: hash(
          readFileSync("config/execution-policies.json", "utf8"),
        ),
        generatedChainsSha256: hash(rendered),
        chainIds: rows.map((c) => c.chainId),
        note: "Registry presence is not proof of deployed executor readiness, liquidity or simulator parity.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Generated ${rows.length} launched chains from ${commit}`);
}
