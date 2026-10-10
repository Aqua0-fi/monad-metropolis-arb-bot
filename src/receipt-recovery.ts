import { readFileSync, lstatSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { createPublicClient, http } from "viem";
import { z } from "zod";
import { loadChains, settingsSchema } from "./config.js";
import { Journal, acquireLock } from "./state.js";
import { HistoryStore } from "./history.js";
import { reconcile, type ReconciliationOptions } from "./reconciliation.js";
import { safeError } from "./diagnostics.js";

/** One-shot receipt maintenance only. The RPC arrives on stdin and is never written to a file.
 * The caller must stop the worker and obtain its runtime flock before opening this program.
 * There is no import of Runner, workerAccount, KMS, a wallet client or transaction submission.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      runtime: { type: "string", default: "runtime" },
      chain: { type: "string" },
      transaction: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  const chainId = z.coerce.number().int().positive().parse(values.chain);
  const expectedHash = z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .parse(values.transaction);
  if (!values.config)
    throw new Error("An explicit existing settings file is required");
  const configPath = resolve(values.config),
    runtime = resolve(values.runtime);
  for (const path of [
    configPath,
    join(runtime, "journal.json"),
    join(runtime, "history.sqlite"),
  ]) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(
        "Recovery requires existing regular settings, journal and history files",
      );
  }
  const settings = settingsSchema.parse(
    JSON.parse(readFileSync(configPath, "utf8")),
  );
  const chain = loadChains().find((c) => c.chainId === chainId);
  if (!chain || !settings.execution[String(chainId)])
    throw new Error("Receipt chain is outside the configured account scope");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk);
    length += value.length;
    if (length > 8192) throw new Error("Recovery RPC input is too large");
    chunks.push(value);
  }
  const input = z
    .object({ rpcUrl: z.url().max(4096) })
    .strict()
    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const url = new URL(input.rpcUrl);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("Recovery RPC must use HTTPS or a local test server");
  const client = createPublicClient({
    cacheTime: 0,
    transport: http(input.rpcUrl, { timeout: 10000, retryCount: 0 }),
  });
  const unlock = acquireLock(join(runtime, "worker.lock"));
  let history: HistoryStore | undefined;
  try {
    const journal = new Journal(join(runtime, "journal.json"));
    const account = `${chainId}:${settings.execution[String(chainId)]!.operator.toLowerCase()}`;
    if (journal.pendingAccounts().some((k) => k !== account))
      throw new Error(
        "Other pending accounts require their own reconciliation",
      );
    history = new HistoryStore(join(runtime, "history.sqlite"));
    let proof:
      | Parameters<NonNullable<ReconciliationOptions["onVerified"]>>[0]
      | undefined;
    let issue:
      | Parameters<NonNullable<ReconciliationOptions["onIssue"]>>[0]
      | undefined;
    const ok = await reconcile(client, chain, settings, journal, history, {
      expectedHash,
      requireFeeEvidence: true,
      dryRun: !values.apply,
      onVerified: (p) => {
        proof = p;
      },
      onIssue: (i) => {
        issue = i;
      },
    });
    if (!ok || !proof?.receipt?.feeValuation)
      throw new Error(
        issue
          ? `Receipt recovery ${issue.stage}: ${issue.reason}`
          : "Receipt is not confirmed with complete historical fee evidence",
      );
    const stored = history.get(settings.networkMode, chainId, expectedHash);
    if (
      values.apply &&
      (journal.get(account).pending || stored?.status !== proof.status)
    )
      throw new Error(
        "The verified receipt did not persist fully; leave the worker stopped",
      );
    console.log(
      JSON.stringify(
        {
          state: values.apply ? "reconciled" : "verified-preview",
          chainId,
          network: settings.networkMode,
          transactionHash: expectedHash,
          status: proof.status,
          receipt: proof.receipt,
          economics: history.economics(settings.networkMode),
          journalReleased: values.apply && !journal.get(account).pending,
          signatures: 0,
          transactions: 0,
          settingsChanged: false,
          permissionsChanged: false,
        },
        (_, v) => (typeof v === "bigint" ? String(v) : v),
        2,
      ),
    );
  } finally {
    history?.close();
    unlock();
  }
}
main().catch((error) => {
  console.log(
    JSON.stringify({
      state: "recovery-stopped",
      reason: safeError(error),
      signatures: 0,
      transactions: 0,
    }),
  );
  process.exitCode = 1;
});
