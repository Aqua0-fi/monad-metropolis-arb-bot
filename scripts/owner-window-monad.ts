/**
 * Onchain half of the Monad timed run, driven by ops/owner-timed-run-monad.py:
 *   preflight  read-only checks and the per-run worker config (no credential needed for observe)
 *   open       setActiveUntil(now + minutes + grace), then setPaused(false)   [execute only]
 *   close      setPaused(true), then setActiveUntil(0); retry-safe, journaled, verified
 *   status     read-only paused/activeUntil (exit 0 = OFF, 4 = ON)
 *   summary    read-only report of the run
 * The onchain activeUntil window stops trading by itself even if this tooling dies.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  decodeEventLog,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  type Abi,
  type Address,
} from "viem";
import { loadChains } from "../src/config.js";
import {
  MONAD_CHAIN_ID,
  checkWorkerConfig,
  confirmationPhrase,
  isOff,
  monadOwnerAbi,
  observeCopy,
  readMonadState,
  windowCloseSteps,
  windowDeadline,
  windowOpenSteps,
  type MonadState,
} from "../src/owner-monad.js";
import {
  REPO_ROOT,
  deployedExecutor,
  kmsIdentity,
  loadPolicy,
  loadReviewedArtifact,
  monadClient,
  rpcFrom,
  signerFrom,
  stateDirFrom,
} from "../src/owner-monad-cli.js";
import {
  OwnerJournal,
  OwnerSafetyError,
  PAID_MONAD_RPC_ENV,
  acquireOwnerLock,
  isLoopbackRpc,
  json,
  ownerIdentity,
  readPrivateJson,
  reconcileRecord,
  sendOwnerCall,
  writePrivateFile,
  type OwnerCallStep,
  type SendContext,
} from "../src/owner-tx.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rpc: { type: "string" },
    signer: { type: "string" },
    "state-dir": { type: "string" },
    executor: { type: "string" },
    registry: { type: "string" },
    mode: { type: "string" },
    minutes: { type: "string" },
    "run-id": { type: "string" },
    confirm: { type: "string" },
    "worker-rpc-explicit": { type: "boolean", default: false },
    since: { type: "string" },
    "worker-log": { type: "string" },
    "worker-home": { type: "string" },
    // Test-only: point the per-run worker at a 127.0.0.1 stub backend (requires a 127.0.0.1 RPC).
    "api-url": { type: "string" },
  },
});
const command = positionals[0] ?? "";
let policy: ReturnType<typeof loadPolicy>;
let signerMode: ReturnType<typeof signerFrom>;
let rpcUrl: string;
let stateDir: string;
let client: ReturnType<typeof monadClient>;
let runId: string;
let runDir: string;
function init() {
  policy = loadPolicy();
  signerMode = signerFrom(values.signer);
  rpcUrl = rpcFrom(values.rpc);
  stateDir = stateDirFrom(values["state-dir"]);
  client = monadClient(rpcUrl);
  runId =
    values["run-id"] ??
    `manual-${new Date().toISOString().replace(/[-:.]/g, "")}`;
  if (!/^[A-Za-z0-9-]{4,48}$/.test(runId))
    throw new OwnerSafetyError("Invalid --run-id");
  runDir = join(stateDir, "runs", runId);
}

async function owner(): Promise<Address> {
  return signerMode === "anvil-test"
    ? (await ownerIdentity("anvil-test", client, rpcUrl, policy.owner)).address
    : policy.owner;
}
function optionalExecutor(): Address | undefined {
  try {
    return deployedExecutor(stateDir, values.executor);
  } catch {
    return undefined;
  }
}
async function readSwitch(executor: Address) {
  const block = await client.getBlock();
  const read = (functionName: string) =>
    client.readContract({
      address: executor,
      abi: monadOwnerAbi as Abi,
      functionName,
      blockNumber: block.number,
    }) as Promise<any>;
  const [paused, activeUntil, onchainOwner] = await Promise.all([
    read("paused"),
    read("activeUntil"),
    read("owner"),
  ]);
  return {
    executor,
    paused: paused as boolean,
    activeUntil: BigInt(activeUntil),
    owner: getAddress(onchainOwner),
    blockNumber: block.number,
    timestamp: block.timestamp,
  };
}
function windowJournal(ownerAddress: Address, executor: Address) {
  return new OwnerJournal(join(stateDir, "window-journal.json"), {
    chainId: MONAD_CHAIN_ID,
    owner: ownerAddress,
    scope: `monad-window:${executor}`,
  });
}
function runMeta(journal: OwnerJournal) {
  const runs = (journal.data.meta.runs ??= {}) as Record<
    string,
    Record<string, unknown>
  >;
  return (runs[runId] ??= {});
}
const iso = (seconds: bigint) =>
  seconds === 0n
    ? "0 (closed)"
    : new Date(Number(seconds) * 1000).toISOString();

async function preflight() {
  const mode = values.mode;
  if (mode !== "observe" && mode !== "execute")
    throw new OwnerSafetyError("--mode must be observe or execute");
  const minutes = Number(values.minutes);
  if (
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > policy.window.maxMinutes
  )
    throw new OwnerSafetyError(
      `--minutes must be an integer from 1 to ${policy.window.maxMinutes}`,
    );
  const errors: string[] = [];
  const warnings: string[] = [];
  if ((await client.getChainId()) !== MONAD_CHAIN_ID)
    errors.push("RPC is not Monad (chain 143)");
  if (process.env[PAID_MONAD_RPC_ENV] && !values["worker-rpc-explicit"])
    errors.push(
      `${PAID_MONAD_RPC_ENV} (the backend's paid endpoint) is set in the worker environment`,
    );
  const needed = ["AQUA0_READ_API_KEY"];
  if (mode === "execute") {
    needed.push("AQUA0_OPERATOR_API_KEY");
    if (signerMode === "kms")
      needed.push(
        "AWS_REGION",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "MARKET_REBALANCER_KMS_KEY_ID",
        "MARKET_REBALANCER_OPERATOR_ADDRESS",
      );
  }
  const missingCreds = needed.filter((name) => !process.env[name]);
  for (const name of missingCreds)
    errors.push(`Credential env ${name} is not loaded`);
  const ownerAddress = await owner();
  const executor = optionalExecutor();
  let state: MonadState | undefined;
  if (!executor) {
    if (mode === "execute")
      errors.push(
        "No verified Monad executor deployment (runtime/monad-pilot/deployment.json)",
      );
    else
      warnings.push(
        "No executor deployed yet; observe-only run without executor checks",
      );
  } else {
    try {
      state = await readMonadState(
        client,
        policy,
        executor,
        ownerAddress,
        loadReviewedArtifact().artifact,
      );
    } catch (error) {
      errors.push(
        `Executor verification failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
  const windowWorstFee =
    4n * policy.budgets.maxOwnerCallGas * policy.budgets.ownerMaxFeePerGasWei;
  if (state) {
    if (!isOff(state))
      warnings.push(
        `Executor is currently ON (paused=${state.paused}, activeUntil=${iso(state.activeUntil)}). ${mode === "execute" ? "This run's close step will turn it OFF." : "Run --close-only to turn it OFF now."}`,
      );
    if (mode === "execute") {
      if (!state.operator)
        errors.push("Owner wallet is not an allowed operator (run setup)");
      if (state.maxInput === 0n || state.minProfit === 0n)
        errors.push("USDC limits are not set (run setup)");
      if (state.maxGasPrice === 0n)
        errors.push("Executor gas-price ceiling is not set (run setup)");
      else if (state.maxGasPrice < state.gasPrice)
        errors.push(
          `Live gas price ${formatUnits(state.gasPrice, 9)} gwei exceeds the executor ceiling`,
        );
      if (!Object.values(state.aquaPools).some(Boolean))
        errors.push("No Aqua0 V4 pool is allowlisted (run setup)");
      if (!Object.values(state.v3Pools).some(Boolean))
        errors.push("No external V3 pool is allowlisted (run setup)");
      if (state.executorBase === 0n)
        errors.push("Executor holds no USDC (run setup to fund it)");
      else if (state.executorBase < state.maxInput)
        warnings.push(
          `Executor holds ${formatUnits(state.executorBase, 6)} USDC, below the ${formatUnits(state.maxInput, 6)} max input`,
        );
      if (state.ownerNative < windowWorstFee + policy.budgets.ownerReserveWei)
        errors.push(
          `Owner wallet has ${formatEther(state.ownerNative)} MON; needs at least ${formatEther(windowWorstFee + policy.budgets.ownerReserveWei)} MON for open/close plus the reserve`,
        );
    }
  }
  // Per-run worker config (local file only).
  let config: Record<string, any> | undefined;
  const base = join(stateDir, "execute.json");
  try {
    if (mode === "execute") {
      if (!existsSync(base))
        throw new OwnerSafetyError(
          `${base} is missing; run owner-setup-monad --enable`,
        );
      config = readPrivateJson<Record<string, any>>(base);
      config.mode = "execute";
      config.execution["143"].allowBroadcast = true;
      if (signerMode === "kms") {
        const kms = kmsIdentity(policy.owner);
        const current = config.execution["143"].kms;
        if (
          !kms ||
          !current ||
          current.keyId !== kms.keyId ||
          current.region !== kms.region
        )
          errors.push(
            "Worker config KMS key differs from the owner's KMS identity record",
          );
        if (
          process.env.MARKET_REBALANCER_KMS_KEY_ID &&
          current?.keyId !== process.env.MARKET_REBALANCER_KMS_KEY_ID
        )
          errors.push(
            "Worker config KMS key differs from the loaded owner KMS key",
          );
      }
    } else if (existsSync(base))
      config = observeCopy(readPrivateJson<Record<string, any>>(base));
    else {
      config = JSON.parse(
        readFileSync(
          join(REPO_ROOT, "config/monad-v4-pilot.observe.json"),
          "utf8",
        ),
      );
      for (const key of Object.keys(config!))
        if (key.startsWith("_")) delete config![key];
      config!.mode = "observe";
    }
  } catch (error) {
    errors.push(
      `Worker config: ${error instanceof Error ? error.message : "unreadable"}`,
    );
  }
  if (values["api-url"] !== undefined) {
    let host = "";
    try {
      host = new URL(values["api-url"]).hostname;
    } catch {
      /* invalid */
    }
    if (!isLoopbackRpc(rpcUrl) || host !== "127.0.0.1")
      errors.push("--api-url is test-only (127.0.0.1 backend and RPC)");
    else if (config) config.apiUrl = values["api-url"];
  }
  const registryPath = resolve(
    values.registry ?? join(REPO_ROOT, "config/chains.json"),
  );
  let registry;
  try {
    registry = loadChains(registryPath).find(
      (c) => c.chainId === MONAD_CHAIN_ID,
    );
  } catch {
    errors.push(`Worker registry ${registryPath} is unreadable`);
  }
  if (config) {
    const check = checkWorkerConfig(config, {
      policy,
      state,
      registry,
      mode,
      workerRpcExplicit: values["worker-rpc-explicit"],
    });
    errors.push(...check.errors);
    warnings.push(...check.warnings);
  }
  const gasPrice = state?.gasPrice ?? (await client.getGasPrice());
  const workerMaxFee = config?.execution?.["143"]?.maxFeePerGas;
  if (workerMaxFee && BigInt(workerMaxFee) < gasPrice)
    warnings.push(
      `Live gas price ${formatUnits(gasPrice, 9)} gwei is above the worker maxFeePerGas`,
    );
  const report = {
    ok: errors.length === 0,
    mode,
    minutes,
    runId,
    chainId: MONAD_CHAIN_ID,
    rpc: new URL(rpcUrl).host,
    workerRpc: values["worker-rpc-explicit"]
      ? "explicit --rpc"
      : (registry?.publicRpc ?? "unknown"),
    owner: ownerAddress,
    executor: executor ?? null,
    executorState: state
      ? {
          block: String(state.blockNumber),
          paused: state.paused,
          activeUntil: iso(state.activeUntil),
          operatorAllowed: state.operator,
          usdcMaxInput: formatUnits(state.maxInput, 6),
          usdcMinProfit: formatUnits(state.minProfit, 6),
          gasCeilingGwei: formatUnits(state.maxGasPrice, 9),
          aquaPools: state.aquaPools,
          v3Pools: state.v3Pools,
          executorUsdc: formatUnits(state.executorBase, 6),
          ownerUsdc: formatUnits(state.ownerBase, 6),
          ownerMon: formatEther(state.ownerNative),
        }
      : null,
    liveGasPriceGwei: formatUnits(gasPrice, 9),
    windowIfOpenedNow:
      mode === "execute" && state
        ? iso(
            windowDeadline(
              state.timestamp,
              minutes,
              policy.window.graceSeconds,
            ),
          )
        : "observe mode: no onchain window, no signing",
    worstCaseOpenCloseFeeMon: formatEther(windowWorstFee),
    workerConfig: join(runDir, "worker.json"),
    credentialsPresent: missingCreds.length === 0,
    errors,
    warnings,
  };
  if (config && errors.length === 0)
    writePrivateFile(join(runDir, "worker.json"), config);
  writePrivateFile(join(runDir, "preflight.json"), report);
  console.log(json(report));
  process.exitCode = errors.length ? 2 : 0;
}

function sendContext(
  journal: OwnerJournal,
  identity: Awaited<ReturnType<typeof ownerIdentity>>,
  executor: Address,
  mode: "strict" | "close",
): SendContext {
  return {
    client,
    journal,
    chainId: MONAD_CHAIN_ID,
    identity,
    gas: {
      maxFeePerGas:
        mode === "close"
          ? policy.budgets.emergencyMaxFeePerGasWei
          : policy.budgets.ownerMaxFeePerGasWei,
      priorityFeeWei: policy.budgets.priorityFeeWei,
      priceMarginBps: BigInt(policy.budgets.priceMarginBps),
      gasMarginBps: BigInt(policy.budgets.ownerCallGasMarginBps),
      maxGas: policy.budgets.maxOwnerCallGas,
    },
    allowedTargets: [executor],
    ...(mode === "strict"
      ? {
          budgetWei: policy.budgets.maxWindowFeeWei,
          budgetPrefix: `open:${runId}:`,
          reserveWei: policy.budgets.ownerReserveWei,
        }
      : { reserveWei: 0n }),
    mode,
    receiptTimeoutMs: 60_000,
    log: (line) => console.log(line),
  };
}

async function open() {
  const minutes = Number(values.minutes);
  if (
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > policy.window.maxMinutes
  )
    throw new OwnerSafetyError(
      `--minutes must be an integer from 1 to ${policy.window.maxMinutes}`,
    );
  if (values.confirm !== confirmationPhrase("run", minutes))
    throw new OwnerSafetyError(
      "Typed confirmation does not match; nothing was signed",
    );
  if (signerMode === "kms" && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new OwnerSafetyError(
      "Opening a live window requires the owner at an interactive terminal",
    );
  const executor = deployedExecutor(stateDir, values.executor);
  const ownerAddress = await owner();
  const state = await readMonadState(
    client,
    policy,
    executor,
    ownerAddress,
    loadReviewedArtifact().artifact,
  );
  const identity = await ownerIdentity(
    signerMode,
    client,
    rpcUrl,
    policy.owner,
  );
  const release = acquireOwnerLock(join(stateDir, "owner.lock"));
  try {
    const journal = windowJournal(ownerAddress, executor);
    const reconcile = sendContext(journal, identity, executor, "close");
    for (const record of journal.unresolved())
      await reconcileRecord(reconcile, record);
    const activeUntil = windowDeadline(
      state.timestamp,
      minutes,
      policy.window.graceSeconds,
    );
    Object.assign(runMeta(journal), {
      minutes,
      openedAtMs: Date.now(),
      openBlock: String(state.blockNumber),
      activeUntil: String(activeUntil),
      ownerMonBefore: String(state.ownerNative),
      executorUsdcBefore: String(state.executorBase),
    });
    journal.save();
    const ctx = sendContext(journal, identity, executor, "strict");
    for (const step of windowOpenSteps(executor, runId, activeUntil))
      await sendOwnerCall(ctx, step);
    const after = await readSwitch(executor);
    if (after.paused || after.activeUntil !== activeUntil)
      throw new OwnerSafetyError(
        "The window did not open as reviewed; the close step will turn the executor OFF",
      );
    console.log(
      json({
        opened: true,
        executor,
        activeUntil: String(activeUntil),
        activeUntilIso: iso(activeUntil),
      }),
    );
  } finally {
    release();
  }
}

async function close() {
  const executor = deployedExecutor(stateDir, values.executor);
  const ownerAddress = await owner();
  const before = await readSwitch(executor);
  if (getAddress(before.owner) !== getAddress(ownerAddress))
    throw new OwnerSafetyError(
      "Executor owner differs from the configured owner",
    );
  if (isOff(before)) {
    console.log(
      json({
        closed: true,
        alreadyOff: true,
        executor,
        paused: true,
        activeUntil: "0",
        block: String(before.blockNumber),
      }),
    );
    return;
  }
  const identity = await ownerIdentity(
    signerMode,
    client,
    rpcUrl,
    policy.owner,
  );
  const release = acquireOwnerLock(join(stateDir, "owner.lock"));
  try {
    const journal = windowJournal(ownerAddress, executor);
    const ctx = sendContext(journal, identity, executor, "close");
    for (const record of journal.unresolved()) {
      try {
        await reconcileRecord(ctx, record);
      } catch (error) {
        console.log(
          `could not reconcile ${record.id}: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
    for (let attempt = 1; attempt <= 5; attempt++) {
      const now = await readSwitch(executor);
      if (isOff(now)) break;
      for (const step of windowCloseSteps(now, runId, attempt)) {
        let unique: OwnerCallStep = step;
        for (let n = 2; journal.find(unique.id); n++)
          unique = { ...step, id: `${step.id}#${n}` };
        try {
          await sendOwnerCall(ctx, unique);
        } catch (error) {
          console.log(
            `close step ${unique.id} failed (will re-check and retry): ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    const final = await readSwitch(executor);
    const meta = runMeta(journal);
    meta.closedAtMs = Date.now();
    meta.closeBlock = String(final.blockNumber);
    journal.save();
    if (!isOff(final)) {
      console.log(
        json({
          closed: false,
          executor,
          paused: final.paused,
          activeUntil: iso(final.activeUntil),
          warning: `EXECUTOR NOT VERIFIED OFF. It stops trading by itself at ${iso(final.activeUntil)}. Rerun: python3 ops/owner-timed-run-monad.py --close-only`,
        }),
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      json({
        closed: true,
        executor,
        paused: true,
        activeUntil: "0",
        block: String(final.blockNumber),
      }),
    );
  } finally {
    release();
  }
}

async function status() {
  const executor = deployedExecutor(stateDir, values.executor);
  const s = await readSwitch(executor);
  console.log(
    json({
      executor,
      paused: s.paused,
      activeUntil: iso(s.activeUntil),
      off: isOff(s),
      block: String(s.blockNumber),
    }),
  );
  process.exitCode = isOff(s) ? 0 : 4;
}

async function summary() {
  const since = Number(values.since ?? "0");
  if (!Number.isSafeInteger(since) || since <= 0)
    throw new OwnerSafetyError("--since must be a millisecond timestamp");
  const executor = optionalExecutor();
  const ownerAddress = await owner();
  const out: Record<string, unknown> = {
    runId,
    since: new Date(since).toISOString(),
  };
  // Worker transactions recorded by the worker's own history store.
  const workerHome = resolve(values["worker-home"] ?? REPO_ROOT);
  const historyPath = join(workerHome, "runtime/history.sqlite");
  const hashes: { hash: `0x${string}`; status: string }[] = [];
  if (existsSync(historyPath)) {
    const db = new DatabaseSync(historyPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT transaction_hash, status, prepared_at FROM executions WHERE chain_id = ? ORDER BY seq DESC LIMIT 500",
        )
        .all(MONAD_CHAIN_ID) as {
        transaction_hash: string;
        status: string;
        prepared_at: string;
      }[];
      for (const row of rows)
        if (Date.parse(row.prepared_at) >= since)
          hashes.push({
            hash: row.transaction_hash as `0x${string}`,
            status: row.status,
          });
    } finally {
      db.close();
    }
  }
  let landed = 0,
    reverted = 0,
    pending = 0,
    gasWei = 0n,
    profitRaw = 0n;
  for (const { hash } of hashes.slice(0, 200)) {
    try {
      const [receipt, tx] = await Promise.all([
        client.getTransactionReceipt({ hash }),
        client.getTransaction({ hash }),
      ]);
      gasWei += tx.gas * receipt.effectiveGasPrice; // Monad charges the full gas limit
      if (receipt.status === "success") landed++;
      else reverted++;
      for (const log of receipt.logs) {
        if (!executor || getAddress(log.address) !== executor) continue;
        try {
          const event = decodeEventLog({
            abi: monadOwnerAbi,
            data: log.data,
            topics: log.topics,
          });
          if (event.eventName === "Executed")
            profitRaw += (event.args as { profit: bigint }).profit;
        } catch {
          /* other executor events */
        }
      }
    } catch {
      pending++;
    }
  }
  out.workerTrades = {
    submitted: hashes.length,
    landedSuccess: landed,
    reverted,
    pendingOrUnknown: pending,
    gasSpentMon: formatEther(gasWei),
    profitUsdcFromExecutedEvents: formatUnits(profitRaw, 6),
  };
  // Owner window transactions (open/close) and onchain deltas.
  if (executor) {
    const journalPath = join(stateDir, "window-journal.json");
    if (existsSync(journalPath)) {
      const journal = windowJournal(ownerAddress, executor);
      const meta = (
        journal.data.meta.runs as
          | Record<string, Record<string, string>>
          | undefined
      )?.[runId];
      const fees = journal.data.records
        .filter(
          (r) =>
            r.id.startsWith(`open:${runId}:`) ||
            r.id.startsWith(`close:${runId}:`),
        )
        .reduce((sum, r) => sum + BigInt(r.chargedFeeWei ?? "0"), 0n);
      out.windowCalls = {
        transactions: journal.data.records
          .filter(
            (r) =>
              r.id.startsWith(`open:${runId}:`) ||
              r.id.startsWith(`close:${runId}:`),
          )
          .map((r) => ({ id: r.id, hash: r.hash, phase: r.phase })),
        gasSpentMon: formatEther(fees),
      };
      if (meta?.executorUsdcBefore) {
        const [usdc, mon] = await Promise.all([
          client.readContract({
            address: policy.baseToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [executor],
          }),
          client.getBalance({ address: ownerAddress }),
        ]);
        out.onchainDelta = {
          executorUsdcChange: formatUnits(
            usdc - BigInt(meta.executorUsdcBefore),
            6,
          ),
          ownerMonChange: formatEther(mon - BigInt(meta.ownerMonBefore!)),
        };
      }
    }
    const s = await readSwitch(executor);
    out.executorFinal = {
      paused: s.paused,
      activeUntil: iso(s.activeUntil),
      off: isOff(s),
    };
  }
  // Backend calls used, from the worker's persistent budget ledger.
  let ledgerPath = join(workerHome, "runtime/monad-pilot/backend-budget.json");
  try {
    const cfg = JSON.parse(readFileSync(join(runDir, "worker.json"), "utf8"));
    if (typeof cfg.backendBudget?.file === "string")
      ledgerPath = resolve(workerHome, cfg.backendBudget.file);
  } catch {
    /* default ledger path */
  }
  if (existsSync(ledgerPath)) {
    try {
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
        calls?: Record<string, number[]>;
      };
      out.backendCallsThisRun = Object.fromEntries(
        Object.entries(ledger.calls ?? {}).map(([k, list]) => [
          k,
          (list ?? []).filter((t) => t >= since).length,
        ]),
      );
    } catch {
      out.backendCallsThisRun = "ledger unreadable";
    }
  } else out.backendCallsThisRun = "no ledger file";
  if (values["worker-log"] && existsSync(values["worker-log"])) {
    const lines = readFileSync(values["worker-log"], "utf8")
      .split("\n")
      .filter((l) => l.includes("backend_budget_summary"));
    if (lines.length) {
      try {
        out.workerBudgetSummary = JSON.parse(lines[lines.length - 1]!);
      } catch {
        out.workerBudgetSummary = lines[lines.length - 1]!.slice(0, 2000);
      }
    }
  }
  console.log(json(out));
}

const commands: Record<string, () => Promise<void>> = {
  preflight,
  open,
  close,
  status,
  summary,
};
const handler = commands[command];
if (!handler) {
  console.error("Use preflight, open, close, status or summary");
  process.exitCode = 64;
} else
  (async () => {
    init();
    await handler();
  })().catch((error) => {
    console.error(
      `owner-window-monad ${command} stopped: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exitCode = command === "preflight" ? 2 : 1;
  });
