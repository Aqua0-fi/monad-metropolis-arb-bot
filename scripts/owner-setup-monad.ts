/**
 * Owner-run Monad V4 executor setup. Default: read-only preview (no credential, no signature).
 * --enable + typed phrase SETUP MONAD 143: operator, USDC limits, gas ceiling, Aqua0 V4 pool keys,
 * matching external V3 pools, and a capped plain USDC transfer from the owner wallet. Idempotent and
 * journaled; it always leaves the executor PAUSED with activeUntil = 0.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatEther, formatUnits, type Address } from "viem";
import {
  MONAD_CHAIN_ID,
  buildWorkerConfig,
  confirmationPhrase,
  isOff,
  monadFundingPlan,
  monadSetupSteps,
  readMonadState,
  resolveLimits,
  verifyMonadVenues,
  type MonadState,
} from "../src/owner-monad.js";
import {
  KMS_IDENTITY_FILE,
  REPO_ROOT,
  deployedExecutor,
  kmsIdentity,
  loadPolicy,
  loadReviewedArtifact,
  monadClient,
  rpcFrom,
  signerFrom,
  stateDirFrom,
  typedConfirmation,
} from "../src/owner-monad-cli.js";
import {
  OwnerJournal,
  OwnerSafetyError,
  acquireOwnerLock,
  json,
  ownerIdentity,
  reconcileRecord,
  sendOwnerCall,
  writePrivateFile,
  type OwnerCallStep,
  type SendContext,
} from "../src/owner-tx.js";

const { values } = parseArgs({
  options: {
    enable: { type: "boolean", default: false },
    "write-worker-config": { type: "boolean", default: false },
    rpc: { type: "string" },
    signer: { type: "string" },
    "state-dir": { type: "string" },
    executor: { type: "string" },
    template: { type: "string" },
    "max-input-usdc": { type: "string" },
    "min-profit-usdc": { type: "string" },
    "fund-usdc": { type: "string" },
    "max-gas-gwei": { type: "string" },
    pools: { type: "string" },
    "test-confirm": { type: "string" },
  },
});
let phase = "read-only preview";
function summary(s: MonadState) {
  return {
    block: String(s.blockNumber),
    executor: s.executor,
    owner: s.owner,
    paused: s.paused,
    activeUntil: String(s.activeUntil),
    operatorAllowed: s.operator,
    usdcMaxInput: formatUnits(s.maxInput, 6),
    usdcMinProfit: formatUnits(s.minProfit, 6),
    gasPriceCeilingGwei: formatUnits(s.maxGasPrice, 9),
    aquaPoolsAllowed: s.aquaPools,
    v3PoolsAllowed: s.v3Pools,
    executorUsdc: formatUnits(s.executorBase, 6),
    ownerUsdc: formatUnits(s.ownerBase, 6),
    ownerMon: formatEther(s.ownerNative),
    liveGasPriceGwei: formatUnits(s.gasPrice, 9),
  };
}
async function main() {
  const signerMode = signerFrom(values.signer);
  if (values["test-confirm"] !== undefined && signerMode !== "anvil-test")
    throw new OwnerSafetyError(
      "--test-confirm is only accepted with the anvil-test signer",
    );
  if (
    values.enable &&
    signerMode === "kms" &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  )
    throw new OwnerSafetyError(
      "Owner setup requires an interactive local terminal",
    );
  const rpcUrl = rpcFrom(values.rpc);
  const stateDir = stateDirFrom(values["state-dir"]);
  const policy = loadPolicy();
  const { artifact } = loadReviewedArtifact();
  const client = monadClient(rpcUrl);
  const owner: Address =
    signerMode === "anvil-test"
      ? (await ownerIdentity("anvil-test", client, rpcUrl, policy.owner))
          .address
      : policy.owner;
  const executor = deployedExecutor(stateDir, values.executor);
  const limits = resolveLimits(policy, {
    maxInputUsdc: values["max-input-usdc"],
    minProfitUsdc: values["min-profit-usdc"],
    fundUsdc: values["fund-usdc"],
    maxGasGwei: values["max-gas-gwei"],
    pools: values.pools,
  });
  await verifyMonadVenues(client, policy, limits.pools);
  let state = await readMonadState(client, policy, executor, owner, artifact);
  const steps = monadSetupSteps(policy, state, limits);
  const funding = monadFundingPlan(policy, state, limits);
  const templatePath = resolve(
    values.template ?? join(REPO_ROOT, "config/monad-v4-pilot.json"),
  );
  const workerConfigPath = join(stateDir, "execute.json");
  console.log(
    json({
      chainId: MONAD_CHAIN_ID,
      rpc: new URL(rpcUrl).host,
      current: summary(state),
      requested: {
        maxInputUsdc: formatUnits(limits.maxInput, 6),
        minProfitUsdc: formatUnits(limits.minProfit, 6),
        fundTargetUsdc: formatUnits(limits.fundTarget, 6),
        gasPriceCeilingGwei: formatUnits(limits.maxGasPrice, 9),
        pools: limits.pools.map(
          (p) =>
            `${p.label} (V4 fee ${p.fee}/spacing ${p.tickSpacing}; V3 ${p.externalPool})`,
        ),
      },
      setupSteps: steps.map((s) => s.description),
      funding:
        funding.kind === "transfer"
          ? funding.step.description
          : funding.kind === "insufficient"
            ? funding.instructions
            : `Executor already holds ${formatUnits(funding.executorBase, 6)} USDC (target ${formatUnits(limits.fundTarget, 6)})`,
      setupFeeCapMon: formatEther(policy.budgets.maxSetupFeeWei),
      endsPaused: true,
      endsWithActiveUntil: 0,
      workerConfig: {
        template: templatePath,
        templatePresent: existsSync(templatePath),
        output: workerConfigPath,
      },
      signatures: 0,
    }),
  );
  if (!values.enable && !values["write-worker-config"]) {
    console.log(
      "PREVIEW ONLY. No credential was loaded and nothing was signed. Rerun with --enable to apply.",
    );
    return;
  }
  const release = acquireOwnerLock(join(stateDir, "owner.lock"));
  try {
    if (values.enable) {
      phase = "owner confirmation";
      const expected = confirmationPhrase("setup");
      const confirmed =
        values["test-confirm"] !== undefined
          ? values["test-confirm"] === expected
          : await typedConfirmation(
              "This configures the paused Monad executor and may transfer USDC from the owner wallet into it. Trading stays OFF.",
              expected,
            );
      if (!confirmed) {
        console.log("Cancelled. No signature or transaction was produced.");
        process.exitCode = 1;
        return;
      }
      const identity = await ownerIdentity(
        signerMode,
        client,
        rpcUrl,
        policy.owner,
      );
      const journal = new OwnerJournal(join(stateDir, "setup-journal.json"), {
        chainId: MONAD_CHAIN_ID,
        owner,
        scope: `monad-setup:${executor}`,
      });
      const ctx: SendContext = {
        client,
        journal,
        chainId: MONAD_CHAIN_ID,
        identity,
        gas: {
          maxFeePerGas: policy.budgets.ownerMaxFeePerGasWei,
          priorityFeeWei: policy.budgets.priorityFeeWei,
          priceMarginBps: BigInt(policy.budgets.priceMarginBps),
          gasMarginBps: BigInt(policy.budgets.ownerCallGasMarginBps),
          maxGas: policy.budgets.maxOwnerCallGas,
        },
        allowedTargets: [executor, policy.baseToken],
        budgetWei: policy.budgets.maxSetupFeeWei,
        budgetPrefix: "setup:",
        reserveWei: policy.budgets.ownerReserveWei,
        mode: "strict",
        log: (l) => console.log(l),
      };
      phase = "reconciling earlier setup transactions";
      for (const record of journal.unresolved())
        await reconcileRecord(ctx, record);
      const unique = (step: OwnerCallStep): OwnerCallStep => {
        let id = step.id;
        for (let n = 2; journal.find(id); n++) id = `${step.id}#${n}`;
        return { ...step, id };
      };
      phase = "onchain setup";
      state = await readMonadState(client, policy, executor, owner, artifact);
      for (const step of monadSetupSteps(policy, state, limits))
        await sendOwnerCall(ctx, unique(step));
      state = await readMonadState(client, policy, executor, owner, artifact);
      const plan = monadFundingPlan(policy, state, limits);
      if (plan.kind === "transfer") {
        phase = "capped USDC funding transfer";
        await sendOwnerCall(ctx, unique(plan.step));
      } else if (plan.kind === "insufficient") console.log(plan.instructions);
      state = await readMonadState(client, policy, executor, owner, artifact);
      const remaining = monadSetupSteps(policy, state, limits);
      if (remaining.length || !isOff(state))
        throw new OwnerSafetyError(
          "Onchain setup is incomplete after the journaled steps; trading stays OFF",
        );
      console.log(
        json({
          status:
            state.executorBase >= limits.fundTarget
              ? "configured_paused"
              : "configured_paused_unfunded",
          final: summary(state),
          setupGasSpentMon: formatEther(journal.spentWei("setup:")),
          transactions: journal.data.records.map((r) => ({
            id: r.id,
            hash: r.hash,
            phase: r.phase,
          })),
        }),
      );
    }
    phase = "worker configuration";
    if (!existsSync(templatePath)) {
      console.log(
        `Worker template ${templatePath} is missing; the runtime worker config was NOT written.`,
      );
      return;
    }
    const template = JSON.parse(readFileSync(templatePath, "utf8"));
    const kms = signerMode === "kms" ? kmsIdentity(policy.owner) : null;
    if (signerMode === "kms" && !kms) {
      console.log(
        `KMS identity record ${KMS_IDENTITY_FILE} is missing; the runtime worker config was NOT written.`,
      );
      return;
    }
    // allowBroadcast stays false here; only the timed run's per-window copy sets it to true.
    const config = buildWorkerConfig(template, {
      executor,
      operator: owner,
      mode: "execute",
      allowBroadcast: false,
      maxInput: limits.maxInput,
      signer: kms ? { kms } : { privateKeyEnv: "MONAD_PILOT_TEST_ONLY_KEY" },
    });
    writePrivateFile(workerConfigPath, config);
    console.log(
      `Wrote ${workerConfigPath} (executor ${executor}). Run it only through python3 ops/owner-timed-run-monad.py; the executor stays paused with activeUntil = 0 until a timed window opens.`,
    );
  } finally {
    release();
  }
}
main().catch((error) => {
  console.error(
    `Owner setup stopped during ${phase}: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  console.error(
    "Keep runtime/monad-pilot/setup-journal.json. A saved or uncertain transaction is checked before any retry.",
  );
  process.exitCode = 1;
});
