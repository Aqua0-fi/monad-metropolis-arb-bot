import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicClient } from "viem";
import { loadChains, settingsSchema } from "../src/config.js";
import { HistoryStore, executionSchema } from "../src/history.js";
import { Journal } from "../src/state.js";
import { reconcile } from "../src/reconciliation.js";

function fixture() {
  const source = JSON.parse(
    readFileSync("test/fixtures/arbitrum-first-execution.json", "utf8"),
  );
  const record = executionSchema.parse(source.record),
    r = source.receipt;
  const receipt = {
    ...r,
    blockNumber: BigInt(r.blockNumber),
    gasUsed: BigInt(r.gasUsed),
    effectiveGasPrice: BigInt(r.effectiveGasPrice),
    logs: r.logs.map((l: Record<string, unknown>) => ({
      ...l,
      blockNumber: BigInt(l.blockNumber as string),
    })),
  };
  const chain = loadChains().find((c) => c.chainId === 42161)!;
  const settings = settingsSchema.parse({
    apiUrl: "http://127.0.0.1:1",
    mode: "observe",
    networkMode: "mainnet",
    confirmations: 2,
    execution: {
      42161: {
        executor: record.executor,
        operator: record.operator,
        privateKeyEnv: "NOT_LOADED_BY_RECOVERY",
        allowBroadcast: false,
        maxGasUnits: "2000000",
        maxFeePerGas: "50000000",
        l1FeeReserveWei: "0",
        maxDailyGasWei: "200000000000000",
        wrappedNative: record.tokenOut,
        gasConversionFee: 100,
      },
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "receipt-reconcile-")),
    path = join(dir, "journal.json"),
    journal = new Journal(path),
    history = new HistoryStore(join(dir, "history.sqlite"));
  const key = `42161:${record.operator}`;
  journal.reserve(
    key,
    record.transactionHash as `0x${string}`,
    9,
    record.tradeId,
    22101240000000n,
    200000000000000n,
    true,
  );
  history.prepare(record);
  const client = {
    getChainId: async () => 42161,
    getTransactionReceipt: async () => receipt,
    getTransaction: async () => ({
      hash: record.transactionHash,
      nonce: 9,
      from: record.operator,
      to: record.executor,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
    }),
    getBlockNumber: async () => receipt.blockNumber + 20n,
    getBlock: async () => ({
      number: receipt.blockNumber,
      hash: receipt.blockHash,
      timestamp: BigInt(source.blockTimestamp),
    }),
    readContract: async (p: { functionName: string; address: string }) => {
      if (p.functionName === "decimals")
        return p.address.toLowerCase() === record.tokenIn ? 6 : 18;
      if (p.functionName === "symbol") return "USDC";
      if (p.functionName === "factory")
        return record.feePolicy!.venues[0]!.factory;
      if (p.functionName === "getPool") return source.historicalFeeProof.pool;
      if (p.functionName === "token0") return record.tokenOut;
      if (p.functionName === "token1") return record.tokenIn;
      if (p.functionName === "fee") return 100;
      throw Error("Unexpected readonly method");
    },
    simulateContract: async () => ({
      result: [BigInt(source.historicalFeeProof.tokenCost), 0n, 0, 0n],
    }),
  } as unknown as PublicClient;
  return {
    record,
    receipt,
    chain,
    settings,
    dir,
    path,
    journal,
    history,
    key,
    client,
    close: () => {
      history.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("read-only reconciliation preview verifies the real receipt without clearing a hash or altering history", async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.path, "utf8");
    assert(
      await reconcile(f.client, f.chain, f.settings, f.journal, f.history, {
        dryRun: true,
        expectedHash: f.record.transactionHash,
        requireFeeEvidence: true,
      }),
    );
    assert.equal(readFileSync(f.path, "utf8"), before);
    assert.equal(
      f.history.get("mainnet", 42161, f.record.transactionHash)!.status,
      "pending",
    );
  } finally {
    f.close();
  }
});

test("reconciliation writes exact realized history before releasing the same mined nonce", async () => {
  const f = fixture();
  try {
    assert(
      await reconcile(f.client, f.chain, f.settings, f.journal, f.history, {
        expectedHash: f.record.transactionHash,
        requireFeeEvidence: true,
      }),
    );
    assert.equal(f.journal.get(f.key).pending, undefined);
    assert.equal(f.journal.get(f.key).reservedWei, "22101240000000");
    const e = f.history.economics("mainnet");
    assert.equal(e.pending, 0);
    assert.equal(e.blocked, false);
    assert.equal(e.totals[0]!.netResult, "657443");
    assert(
      await reconcile(f.client, f.chain, f.settings, f.journal, f.history, {
        expectedHash: f.record.transactionHash,
        requireFeeEvidence: true,
      }),
    );
    assert.equal(f.history.economics("mainnet").totals[0]!.confirmed, 1);
  } finally {
    f.close();
  }
});

test("recovery cannot clear another hash, mismatched sender/nonce, or unknown historical fees", async () => {
  for (const kind of ["hash", "sender", "nonce", "fee"]) {
    const f = fixture();
    try {
      const client = {
        ...f.client,
        ...(kind === "sender"
          ? {
              getTransactionReceipt: async () => ({
                ...f.receipt,
                from: f.record.executor,
              }),
            }
          : {}),
        ...(kind === "nonce"
          ? {
              getTransaction: async () => ({
                hash: f.record.transactionHash,
                nonce: 10,
                from: f.record.operator,
                to: f.record.executor,
                blockNumber: f.receipt.blockNumber,
                blockHash: f.receipt.blockHash,
              }),
            }
          : {}),
        ...(kind === "fee"
          ? {
              readContract: async () => {
                throw Error("archive unavailable https://private.example/key");
              },
            }
          : {}),
      } as unknown as PublicClient;
      const issues: string[] = [];
      assert.equal(
        await reconcile(client, f.chain, f.settings, f.journal, f.history, {
          expectedHash:
            kind === "hash" ? `0x${"cc".repeat(32)}` : f.record.transactionHash,
          requireFeeEvidence: true,
          onIssue: (i) => issues.push(i.reason),
        }),
        false,
      );
      assert(f.journal.get(f.key).pending);
      assert.equal(
        f.history.get("mainnet", 42161, f.record.transactionHash)!.status,
        "pending",
      );
      assert(issues.length > 0);
      assert(!issues.join("").includes("private.example"));
    } finally {
      f.close();
    }
  }
});

test("a journal write failure retains the in-memory and persisted pending entry while settled history stays durable", async () => {
  const f = fixture();
  try {
    mkdirSync(f.path + ".tmp");
    assert.equal(
      await reconcile(f.client, f.chain, f.settings, f.journal, f.history, {
        requireFeeEvidence: true,
      }),
      false,
    );
    assert(f.journal.get(f.key).pending);
    assert(new Journal(f.path).get(f.key).pending);
    assert.equal(
      f.history.get("mainnet", 42161, f.record.transactionHash)!.status,
      "confirmed",
    );
    rmSync(f.path + ".tmp", { recursive: true });
    assert(
      await reconcile(f.client, f.chain, f.settings, f.journal, f.history, {
        requireFeeEvidence: true,
      }),
    );
    assert.equal(f.history.economics("mainnet").totals[0]!.confirmed, 1);
  } finally {
    f.close();
  }
});

test("receipt recovery preserves a previously latched economic pause", async () => {
  const f = fixture();
  try {
    f.history.latchEconomics("mainnet", "net_loss");
    assert(
      await reconcile(f.client, f.chain, f.settings, f.journal, f.history, {
        requireFeeEvidence: true,
      }),
    );
    assert.equal(f.history.economics("mainnet").blocked, true);
    assert.equal(f.history.economics("mainnet").reason, "net_loss");
    assert.equal(f.history.economics("mainnet").totals[0]!.netResult, "657443");
  } finally {
    f.close();
  }
});

test("wrong chain, reorganized receipt and insufficient confirmations preserve the exact pending record", async () => {
  for (const kind of ["chain", "block", "confirmations"]) {
    const f = fixture();
    try {
      const client = {
        ...f.client,
        ...(kind === "chain" ? { getChainId: async () => 1 } : {}),
        ...(kind === "block"
          ? {
              getBlock: async () => ({
                hash: `0x${"ff".repeat(32)}`,
                timestamp: 1n,
                number: f.receipt.blockNumber,
              }),
            }
          : {}),
        ...(kind === "confirmations"
          ? { getBlockNumber: async () => f.receipt.blockNumber }
          : {}),
      } as unknown as PublicClient;
      assert.equal(
        await reconcile(client, f.chain, f.settings, f.journal, f.history, {
          requireFeeEvidence: true,
        }),
        false,
      );
      assert.equal(
        f.journal.get(f.key).pending?.hash,
        f.record.transactionHash,
      );
      assert.equal(
        f.history.get("mainnet", 42161, f.record.transactionHash)!.status,
        "pending",
      );
    } finally {
      f.close();
    }
  }
});

test("the receipt-only runtime dependency graph contains no worker loop or signing module", async () => {
  const ts = await import("typescript");
  const { resolve, dirname } = await import("node:path");
  const seen = new Set<string>();
  function walk(path: string) {
    if (seen.has(path)) return;
    seen.add(path);
    assert(
      !/(?:execution|worker-account|kms-account|runner|aqua|cli)\.ts$/.test(
        path,
      ),
      path,
    );
    const ast = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of ast.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        statement.importClause?.isTypeOnly ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const module = statement.moduleSpecifier.text;
      if (module.startsWith("."))
        walk(resolve(dirname(path), module.replace(/\.js$/, ".ts")));
      else if (
        module === "viem" &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
      )
        for (const item of statement.importClause.namedBindings.elements)
          assert(
            ![
              "createWalletClient",
              "sendTransaction",
              "sendRawTransaction",
              "privateKeyToAccount",
            ].includes(item.name.text),
          );
    }
  }
  walk(resolve("src/receipt-recovery.ts"));
  assert(seen.has(resolve("src/reconciliation.ts")));
});
