/**
 * Owner-run Monad (143) executor deployment. Default is a read-only preview that loads no credential.
 * --send requires an interactive terminal and the typed phrase DEPLOY 143. The deployed executor
 * starts paused with activeUntil = 0, so it cannot trade until a bounded owner window is opened.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  encodeDeployData,
  formatEther,
  formatGwei,
  getAddress,
  getContractAddress,
  keccak256,
  serializeTransaction,
  type Abi,
  type Address,
} from "viem";
import {
  assertCreationBudget,
  normalizeRuntime,
} from "../src/owner-deployment.js";
import {
  monadOwnerAbi,
  confirmationPhrase,
  MONAD_CHAIN_ID,
} from "../src/owner-monad.js";
import {
  DEPLOY_SCOPE,
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
  sendOwnerCreation,
  writePrivateFile,
  type SendContext,
} from "../src/owner-tx.js";

const { values } = parseArgs({
  options: {
    send: { type: "boolean", default: false },
    status: { type: "boolean", default: false },
    rpc: { type: "string" },
    signer: { type: "string" },
    "state-dir": { type: "string" },
    "test-confirm": { type: "string" },
  },
});
let phase = "read-only preparation";
async function main() {
  if (values.send && values.status)
    throw new OwnerSafetyError("Choose either --send or --status");
  const signerMode = signerFrom(values.signer);
  if (values["test-confirm"] !== undefined && signerMode !== "anvil-test")
    throw new OwnerSafetyError(
      "--test-confirm is only accepted with the anvil-test signer",
    );
  if (
    values.send &&
    signerMode === "kms" &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  )
    throw new OwnerSafetyError(
      "Live owner deployment requires an interactive local terminal",
    );
  const rpcUrl = rpcFrom(values.rpc);
  const stateDir = stateDirFrom(values["state-dir"]);
  const policy = loadPolicy();
  const { artifact, creationCodeHash } = loadReviewedArtifact();
  const client = monadClient(rpcUrl);
  if ((await client.getChainId()) !== MONAD_CHAIN_ID)
    throw new OwnerSafetyError("RPC is not Monad (chain 143)");
  // Preview never loads credentials. The test signer resolves only against a 127.0.0.1 anvil.
  const owner: Address =
    signerMode === "anvil-test"
      ? (await ownerIdentity("anvil-test", client, rpcUrl, policy.owner))
          .address
      : policy.owner;
  const journalPath = join(stateDir, "deployment.json");
  const journal = new OwnerJournal(journalPath, {
    chainId: MONAD_CHAIN_ID,
    owner,
    scope: DEPLOY_SCOPE,
  });

  async function verify(executor: Address, blockNumber: bigint) {
    const code = await client.getCode({ address: executor, blockNumber });
    if (
      !code ||
      normalizeRuntime(code, artifact.deployedBytecode) !==
        normalizeRuntime(
          artifact.deployedBytecode.object,
          artifact.deployedBytecode,
        )
    )
      throw new OwnerSafetyError(
        "Deployed code differs from the reviewed runtime",
      );
    const read = (functionName: string): Promise<unknown> =>
      client.readContract({
        address: executor,
        abi: monadOwnerAbi as Abi,
        functionName,
        blockNumber,
      });
    const [onchainOwner, paused, activeUntil, router, permit2, hook, extended] =
      await Promise.all(
        [
          "owner",
          "paused",
          "activeUntil",
          "universalRouter",
          "permit2",
          "aqua0Hook",
          "extendedV4Encoding",
        ].map(read),
      );
    if (
      getAddress(onchainOwner as Address) !== getAddress(owner) ||
      paused !== true ||
      activeUntil !== 0n ||
      getAddress(router as Address) !== policy.universalRouter ||
      getAddress(permit2 as Address) !== policy.permit2 ||
      getAddress(hook as Address) !== policy.aqua0Hook ||
      extended !== policy.extendedV4Encoding
    )
      throw new OwnerSafetyError(
        "Constructor bindings, paused state or activeUntil differ from review",
      );
  }
  async function finish(ctx: SendContext) {
    const record = journal.find("deploy")!;
    const settled = await reconcileRecord(ctx, record);
    if (settled.phase !== "confirmed") return false;
    const executor = getContractAddress({
      from: owner,
      nonce: BigInt(record.nonce),
    });
    if (
      !settled.contractAddress ||
      getAddress(settled.contractAddress) !== executor
    )
      throw new OwnerSafetyError(
        "Deployment receipt address differs from the predicted executor",
      );
    await verify(executor, BigInt(settled.blockNumber!));
    journal.data.meta = {
      ...journal.data.meta,
      executor,
      verified: true,
      verifiedBlock: settled.blockNumber,
    };
    journal.save();
    console.log(
      json({
        status: "verified_paused",
        chainId: MONAD_CHAIN_ID,
        executor,
        owner,
        transactionHash: settled.hash,
        chargedFeeMon: formatEther(BigInt(settled.chargedFeeWei ?? "0")),
        paused: true,
        activeUntil: 0,
        tradingEnabled: false,
        next: "python3 ops/owner-setup-monad.py (preview), then --enable",
      }),
    );
    return true;
  }
  const identityForReads = {
    mode: signerMode,
    address: owner,
    keyId: "",
    region: "",
    transport: {
      publicKey: async () => {
        throw new OwnerSafetyError("no signing in status");
      },
      signDigest: async () => {
        throw new OwnerSafetyError("no signing in status");
      },
    },
  };
  const readCtx: SendContext = {
    client,
    journal,
    chainId: MONAD_CHAIN_ID,
    identity: identityForReads,
    gas: {
      maxFeePerGas: 0n,
      priorityFeeWei: 0n,
      priceMarginBps: 10000n,
      gasMarginBps: 10000n,
      maxGas: 0n,
    },
    allowedTargets: [],
    mode: "strict",
    log: (l) => console.log(l),
  };
  if (values.status || journal.find("deploy")) {
    if (!journal.find("deploy")) {
      console.log("No Monad owner deployment is recorded.");
      return;
    }
    console.log(
      "A Monad deployment is already recorded. Checking it without signing or resending.",
    );
    phase = "receipt verification";
    if (!(await finish(readCtx)))
      console.log(
        "Not confirmed yet; rerun --status later. Nothing was resent.",
      );
    return;
  }

  const block = await client.getBlock();
  const [nonce, latestNonce, balance, gasPrice, priority] = await Promise.all([
    client.getTransactionCount({ address: owner, blockTag: "pending" }),
    client.getTransactionCount({ address: owner, blockTag: "latest" }),
    client.getBalance({ address: owner }),
    client.getGasPrice(),
    client
      .estimateMaxPriorityFeePerGas()
      .catch(() => policy.budgets.priorityFeeWei),
  ]);
  if (nonce !== latestNonce)
    throw new OwnerSafetyError(
      "Owner account has pending transactions; do not guess its deployment nonce",
    );
  const data = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [
      owner,
      policy.universalRouter,
      policy.permit2,
      policy.aqua0Hook,
      policy.extendedV4Encoding,
    ],
  });
  const estimatedGas = await client.estimateGas({
    account: owner,
    data,
    value: 0n,
  });
  const tip =
    priority < policy.budgets.priorityFeeWei
      ? priority
      : policy.budgets.priorityFeeWei;
  const floor = (block.baseFeePerGas ?? 0n) + tip;
  const live = gasPrice > floor ? gasPrice : floor;
  const maxFeePerGas =
    (live * BigInt(policy.budgets.priceMarginBps) + 9999n) / 10000n;
  if (maxFeePerGas > policy.budgets.ownerMaxFeePerGasWei)
    throw new OwnerSafetyError(
      `Live Monad gas price exceeds the ${formatGwei(policy.budgets.ownerMaxFeePerGasWei)} gwei owner ceiling`,
    );
  const tx = {
    type: "eip1559" as const,
    chainId: MONAD_CHAIN_ID,
    nonce,
    // Monad charges the full gas limit: a real estimate plus a small margin, never a round guess.
    gas:
      (estimatedGas * BigInt(policy.budgets.deployGasMarginBps) + 9999n) /
      10000n,
    maxFeePerGas,
    maxPriorityFeePerGas: tip,
    value: 0n as const,
    data,
  };
  assertCreationBudget(tx, policy.budgets.maxDeployFeeWei, MONAD_CHAIN_ID);
  const maximum = tx.gas * tx.maxFeePerGas;
  const predicted = getContractAddress({ from: owner, nonce: BigInt(nonce) });
  const existing = await client.getCode({ address: predicted });
  if (existing && existing !== "0x")
    throw new OwnerSafetyError("Predicted deployment address already has code");
  const unsignedHash = keccak256(serializeTransaction(tx));
  const review = {
    chainId: MONAD_CHAIN_ID,
    rpc: new URL(rpcUrl).host,
    owner,
    predictedExecutor: predicted,
    nonce,
    constructor: {
      universalRouter: policy.universalRouter,
      permit2: policy.permit2,
      aqua0Hook: policy.aqua0Hook,
      extendedV4Encoding: policy.extendedV4Encoding,
    },
    estimatedGas: String(estimatedGas),
    gasLimit: String(tx.gas),
    maxFeePerGasGwei: formatGwei(tx.maxFeePerGas),
    maxPriorityFeePerGasGwei: formatGwei(tx.maxPriorityFeePerGas),
    maximumDeploymentFeeMon: formatEther(maximum),
    commandFeeCapMon: formatEther(policy.budgets.maxDeployFeeWei),
    ownerBalanceMon: formatEther(balance),
    unsignedHash,
    creationCodeHash,
    startsPaused: true,
    activeUntil: 0,
    tradingEnabled: false,
  };
  writePrivateFile(join(stateDir, "deployment-review.json"), {
    ...review,
    transaction: tx,
  });
  console.log(json(review));
  if (balance < maximum) {
    const missing = maximum - balance;
    console.log(
      `The owner wallet ${owner} needs at least ${formatEther(missing)} more MON on Monad (143) to cover the maximum deployment fee. Bridge with: python3 ops/owner-bridge-arbitrum-to-monad.py`,
    );
    if (values.send)
      throw new OwnerSafetyError(
        "Owner MON balance cannot cover the maximum deployment fee",
      );
  }
  if (!values.send) {
    console.log(
      "PREVIEW ONLY. No credential was loaded, nothing was signed or sent. Rerun with --send to deploy.",
    );
    return;
  }
  phase = "owner confirmation";
  const expected = confirmationPhrase("deploy");
  const confirmed =
    values["test-confirm"] !== undefined
      ? values["test-confirm"] === expected
      : await typedConfirmation(
          `This spends at most ${formatEther(maximum)} MON on one PAUSED executor deployment (activeUntil = 0).`,
          expected,
        );
  if (!confirmed) {
    console.log("Cancelled. No signature or transaction was produced.");
    process.exitCode = 1;
    return;
  }
  phase = "fresh pre-sign checks";
  const identity = await ownerIdentity(
    signerMode,
    client,
    rpcUrl,
    policy.owner,
  );
  if (getAddress(identity.address) !== getAddress(owner))
    throw new OwnerSafetyError("Signer identity changed");
  if (
    (await client.getChainId()) !== MONAD_CHAIN_ID ||
    (await client.getTransactionCount({
      address: owner,
      blockTag: "pending",
    })) !== nonce ||
    (await client.getBalance({ address: owner })) < maximum
  )
    throw new OwnerSafetyError(
      "Chain, owner nonce or funding changed while reviewing; nothing was signed",
    );
  const ctx: SendContext = { ...readCtx, identity };
  phase = "owner-requested signing and broadcast";
  const release = acquireOwnerLock(join(stateDir, "owner.lock"));
  try {
    await sendOwnerCreation(ctx, "deploy", tx);
    phase = "receipt verification";
    await finish(ctx);
  } finally {
    release();
  }
}
main().catch((error) => {
  console.error(
    `Stopped during ${phase}: ${error instanceof Error ? error.name : "UnknownError"}.`,
  );
  if (error instanceof Error) console.error(error.message);
  console.error(
    "No success is assumed. Keep runtime/monad-pilot/deployment.json; --status is read-only and never resends.",
  );
  process.exitCode = 1;
});
