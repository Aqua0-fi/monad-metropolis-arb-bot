import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  existsSync,
  lstatSync,
  constants,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient,
  http,
  encodeDeployData,
  getAddress,
  getContractAddress,
  keccak256,
  serializeTransaction,
  parseAbi,
  formatEther,
  parseEther,
  type Address,
  type Hex,
  type Abi,
} from "viem";
import { loadChains } from "../src/config.js";
import {
  createOwnerDeploymentAccount,
  awsKmsTransport,
  type KmsAccountConfig,
} from "../src/kms-account.js";
import {
  assertCreationBudget,
  normalizeRuntime,
  type RuntimeArtifact,
} from "../src/owner-deployment.js";

class OwnerSafetyError extends Error {
  name = "OwnerSafetyError";
}

// This executable is for an owner at a local terminal. No default sending, batch setup or trade activation.
const { values } = parseArgs({
  options: {
    send: { type: "boolean", default: false },
    status: { type: "boolean", default: false },
  },
});
if (values.send && values.status)
  throw new OwnerSafetyError("Choose either --send or --status");
if (values.send && (!process.stdin.isTTY || !process.stdout.isTTY))
  throw new OwnerSafetyError(
    "Live owner deployment requires an interactive local terminal",
  );
const root = resolve(".");
const journalPath = resolve("runtime/owner-launch/arbitrum-deployment.json");
const reviewPath = resolve(
  "runtime/owner-launch/arbitrum-deployment-review.json",
);
const chain = loadChains().find((c) => c.chainId === 42161);
if (!chain?.executionReviewed)
  throw new OwnerSafetyError("Arbitrum deployment policy is not reviewed");
const rpc = createPublicClient({
  transport: http(process.env[chain.rpcEnv] || chain.publicRpc, {
    timeout: 15000,
    retryCount: 0,
  }),
});
const artifact = JSON.parse(
  readFileSync("out/MarketRebalancer.sol/MarketRebalancer.json", "utf8"),
) as {
  abi: Abi;
  bytecode: { object: Hex };
  deployedBytecode: RuntimeArtifact;
  metadata: string | { compiler: { version: string } };
};
const manifest = JSON.parse(
  readFileSync("config/owner-deployment-artifact.json", "utf8"),
);
const metadata =
  typeof artifact.metadata === "string"
    ? JSON.parse(artifact.metadata)
    : artifact.metadata;
if (
  manifest.chainId !== 42161 ||
  metadata.compiler.version !== manifest.compiler ||
  keccak256(artifact.bytecode.object) !== manifest.creationCodeHash
)
  throw new OwnerSafetyError(
    "Build artifact differs from the reviewed executor. Stop and review; do not auto-rebuild for sending.",
  );
const bindingsAbi = parseAbi([
  "function owner() view returns(address)",
  "function paused() view returns(bool)",
  "function universalRouter() view returns(address)",
  "function permit2() view returns(address)",
  "function aqua0Hook() view returns(address)",
  "function extendedV4Encoding() view returns(bool)",
]);
interface ReceiptRecord {
  version: 1;
  chainId: 42161;
  owner: Address;
  predictedExecutor: Address;
  nonce: number;
  unsignedHash: Hex;
  creationCodeHash: Hex;
  phase: string;
  transactionHash: Hex | null;
  createdAt: string;
  verifiedBlock?: string;
  actualExecutionFeeWei?: string;
}
function privateDirectory() {
  const folder = dirname(journalPath);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const s = lstatSync(folder);
  if (
    s.isSymbolicLink() ||
    !s.isDirectory() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o077) !== 0
  )
    throw new OwnerSafetyError("Unsafe owner journal directory");
}
function writePrivate(path: string, value: unknown, create = false) {
  privateDirectory();
  const text =
    JSON.stringify(
      value,
      (_key, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) + "\n";
  if (create) {
    const fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } else {
    if (existsSync(path)) {
      const s = lstatSync(path);
      if (
        s.isSymbolicLink() ||
        s.uid !== process.getuid?.() ||
        (s.mode & 0o077) !== 0
      )
        throw new OwnerSafetyError("Unsafe owner record");
    }
    const temp = `${path}.${process.pid}.tmp`;
    const fd = openSync(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  }
  const fd = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function readJournal(): ReceiptRecord {
  const s = lstatSync(journalPath);
  if (
    s.isSymbolicLink() ||
    !s.isFile() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o077) !== 0
  )
    throw new OwnerSafetyError("Unsafe deployment journal");
  const r = JSON.parse(readFileSync(journalPath, "utf8")) as ReceiptRecord;
  if (
    r.version !== 1 ||
    r.chainId !== 42161 ||
    r.creationCodeHash !== manifest.creationCodeHash ||
    !Number.isSafeInteger(r.nonce) ||
    r.nonce < 0 ||
    getContractAddress({
      from: getAddress(r.owner),
      nonce: BigInt(r.nonce),
    }) !== getAddress(r.predictedExecutor)
  )
    throw new OwnerSafetyError("Deployment journal identity mismatch");
  if (r.transactionHash && !/^0x[0-9a-fA-F]{64}$/.test(r.transactionHash))
    throw new OwnerSafetyError("Invalid saved transaction hash");
  return r;
}
async function verifyReceipt(record: ReceiptRecord, wait: boolean) {
  if (!record.transactionHash) {
    console.log(
      "An earlier signing intent exists without a recorded broadcast hash. Stop for manual review; do not delete the journal or send another deployment.",
    );
    return false;
  }
  let receipt;
  try {
    receipt = wait
      ? await rpc.waitForTransactionReceipt({
          hash: record.transactionHash,
          confirmations: 2,
          timeout: 120000,
          pollingInterval: 2000,
        })
      : await rpc.getTransactionReceipt({ hash: record.transactionHash });
  } catch {
    console.log(
      `Receipt not confirmed yet for ${record.transactionHash}. Run --status later; no replacement or resubmission was attempted.`,
    );
    return false;
  }
  if (receipt.status !== "success") {
    record.phase = "reverted";
    writePrivate(journalPath, record);
    throw new OwnerSafetyError(
      "Owner deployment reverted. Keep the journal and inspect the receipt; do not automatically retry.",
    );
  }
  if (
    !receipt.contractAddress ||
    getAddress(receipt.contractAddress) !==
      getAddress(record.predictedExecutor) ||
    getAddress(receipt.from) !== getAddress(record.owner)
  )
    throw new OwnerSafetyError(
      "Deployment receipt does not match the reviewed owner and contract",
    );
  const current = await rpc.getBlockNumber();
  if (current < receipt.blockNumber + 1n) {
    console.log("Waiting for the configured confirmation count.");
    return false;
  }
  if (
    (await rpc.getBlock({ blockNumber: receipt.blockNumber })).hash !==
    receipt.blockHash
  )
    throw new OwnerSafetyError("Receipt block is not canonical");
  const code = await rpc.getCode({
    address: record.predictedExecutor,
    blockNumber: receipt.blockNumber,
  });
  if (
    !code ||
    normalizeRuntime(code, artifact.deployedBytecode) !==
      normalizeRuntime(
        artifact.deployedBytecode.object,
        artifact.deployedBytecode,
      )
  )
    throw new OwnerSafetyError("Deployed code differs from reviewed runtime");
  const read = (
    functionName:
      | "owner"
      | "paused"
      | "universalRouter"
      | "permit2"
      | "aqua0Hook"
      | "extendedV4Encoding",
  ) =>
    rpc.readContract({
      address: record.predictedExecutor,
      abi: bindingsAbi,
      functionName,
      blockNumber: receipt.blockNumber,
    });
  const [owner, paused, router, permit2, hook, extended] = await Promise.all([
    read("owner"),
    read("paused"),
    read("universalRouter"),
    read("permit2"),
    read("aqua0Hook"),
    read("extendedV4Encoding"),
  ]);
  if (
    getAddress(owner as Address) !== getAddress(record.owner) ||
    paused !== true ||
    getAddress(router as Address) !== getAddress(chain!.universalRouter) ||
    getAddress(permit2 as Address) !== getAddress(chain!.permit2) ||
    getAddress(hook as Address) !== getAddress(chain!.aqua0Hook) ||
    extended !== chain!.extendedV4Encoding
  )
    throw new OwnerSafetyError(
      "Constructor bindings or initial paused state differ from review",
    );
  record.phase = "verified_paused";
  record.verifiedBlock = String(receipt.blockNumber);
  record.actualExecutionFeeWei = String(
    receipt.gasUsed * receipt.effectiveGasPrice,
  );
  writePrivate(journalPath, record);
  console.log(
    JSON.stringify(
      {
        status: record.phase,
        chainId: 42161,
        transactionHash: record.transactionHash,
        executor: record.predictedExecutor,
        owner: record.owner,
        gasUsed: receipt.gasUsed.toString(),
        receiptExecutionFeeEth: formatEther(
          receipt.gasUsed * receipt.effectiveGasPrice,
        ),
        marketApprovalsAdded: 0,
        tradingEnabled: false,
      },
      null,
      2,
    ),
  );
  return true;
}
let phase = "read-only preparation";
async function main() {
  if ((await rpc.getChainId()) !== 42161)
    throw new OwnerSafetyError("RPC is not Arbitrum One");
  if (values.status) {
    if (!existsSync(journalPath)) {
      console.log("No owner deployment is recorded.");
      return;
    }
    await verifyReceipt(readJournal(), false);
    return;
  }
  if (existsSync(journalPath)) {
    console.log(
      "A previous owner deployment intent is already recorded. Checking it without signing or resending.",
    );
    await verifyReceipt(readJournal(), false);
    return;
  }
  const review = JSON.parse(
    readFileSync(
      resolve("../evidence/arbitrum-unsigned-launch-20260929.json"),
      "utf8",
    ),
  );
  const owner = getAddress(
    process.env.MARKET_REBALANCER_OPERATOR_ADDRESS ?? "",
  );
  if (
    owner !== getAddress(review.owner) ||
    review.chainId !== 42161 ||
    review.creationCodeHash !== manifest.creationCodeHash
  )
    throw new OwnerSafetyError(
      "KMS wallet does not match the independently verified funding plan",
    );
  const config: KmsAccountConfig = {
    keyId: process.env.MARKET_REBALANCER_KMS_KEY_ID ?? "",
    region: process.env.AWS_REGION ?? "",
    address: owner,
    chainId: 42161,
  };
  const block = await rpc.getBlock();
  const [nonce, confirmedNonce, balance, gasPrice] = await Promise.all([
    rpc.getTransactionCount({ address: owner, blockTag: "pending" }),
    rpc.getTransactionCount({ address: owner, blockNumber: block.number }),
    rpc.getBalance({ address: owner, blockNumber: block.number }),
    rpc.getGasPrice(),
  ]);
  if (nonce !== confirmedNonce)
    throw new OwnerSafetyError(
      "Owner account has pending transactions; do not guess its deployment nonce",
    );
  const data = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [
      owner,
      chain!.universalRouter,
      chain!.permit2,
      chain!.aqua0Hook,
      chain!.extendedV4Encoding,
    ],
  });
  if (data !== review.deployment.data)
    throw new OwnerSafetyError(
      "Constructor data differs from the reviewed deployment plan",
    );
  const estimatedGas = await rpc.estimateGas({
    account: owner,
    data,
    value: 0n,
  });
  const tx = {
    type: "eip1559" as const,
    chainId: 42161,
    nonce,
    gas: (estimatedGas * 120n + 99n) / 100n,
    maxFeePerGas: gasPrice * 2n,
    maxPriorityFeePerGas: 0n,
    value: 0n,
    data,
  };
  const cap = parseEther("0.0003");
  assertCreationBudget(tx, cap);
  const maximum = tx.gas * tx.maxFeePerGas;
  if (balance < maximum)
    throw new OwnerSafetyError(
      "Operator does not have enough native ETH for the explicit maximum deployment fee",
    );
  const predicted = getContractAddress({ from: owner, nonce: BigInt(nonce) });
  const existingCode = await rpc.getCode({ address: predicted });
  if (existingCode && existingCode !== "0x")
    throw new OwnerSafetyError("Predicted deployment address already has code");
  const digest = keccak256(serializeTransaction(tx));
  // Construction verifies only GetPublicKey. The Sign request occurs below, after terminal confirmation.
  const transport = awsKmsTransport(config.region);
  const account = await createOwnerDeploymentAccount(
    config,
    digest,
    values.send
      ? transport
      : {
          publicKey: transport.publicKey,
          signDigest: async () => {
            throw new OwnerSafetyError("Signing is disabled in preview mode");
          },
        },
  );
  const unsigned = {
    chainId: 42161,
    owner,
    predictedExecutor: predicted,
    nonce,
    constructor: {
      universalRouter: chain!.universalRouter,
      permit2: chain!.permit2,
      aqua0Hook: chain!.aqua0Hook,
      extendedV4Encoding: chain!.extendedV4Encoding,
    },
    transaction: tx,
    unsignedHash: digest,
    creationCodeHash: manifest.creationCodeHash,
    maximumDeploymentFeeEth: formatEther(maximum),
    absoluteCommandFeeCapEth: "0.0003",
    tradingEnabled: false,
  };
  writePrivate(reviewPath, unsigned);
  console.log(
    JSON.stringify(
      {
        ...unsigned,
        transaction: {
          ...tx,
          data: `${data.slice(0, 18)}... (${(data.length - 2) / 2} bytes; exact data in ${reviewPath})`,
        },
      },
      (_key, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
  if (!values.send) {
    console.log(
      "PREVIEW ONLY. No signature or transaction was produced. The owner must explicitly rerun with --send and confirm at the terminal.",
    );
    return;
  }
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await terminal.question(
    "This spends Arbitrum ETH on one paused executor deployment. Type DEPLOY 42161 to authorize: ",
  );
  terminal.close();
  if (answer !== "DEPLOY 42161") {
    console.log("Cancelled. No signature or transaction was produced.");
    return;
  }
  phase = "fresh pre-sign checks";
  if (
    (await rpc.getChainId()) !== 42161 ||
    (await rpc.getTransactionCount({ address: owner, blockTag: "pending" })) !==
      nonce
  )
    throw new OwnerSafetyError("Chain or owner nonce changed while reviewing");
  if ((await rpc.getBalance({ address: owner })) < maximum)
    throw new OwnerSafetyError("Owner funding changed while reviewing");
  if ((await rpc.getGasPrice()) > tx.maxFeePerGas)
    throw new OwnerSafetyError(
      "Gas conditions changed; rebuild the review instead of changing a signed transaction",
    );
  const record: ReceiptRecord = {
    version: 1,
    chainId: 42161,
    owner,
    predictedExecutor: predicted,
    nonce,
    unsignedHash: digest,
    creationCodeHash: manifest.creationCodeHash,
    phase: "signing",
    transactionHash: null,
    createdAt: new Date().toISOString(),
  };
  writePrivate(journalPath, record, true);
  phase = "owner-requested signing";
  const serialized = await account.signTransaction(tx);
  record.transactionHash = keccak256(serialized);
  record.phase = "signed";
  writePrivate(journalPath, record);
  phase = "owner-requested broadcast";
  const sent = await rpc.sendRawTransaction({
    serializedTransaction: serialized,
  });
  if (sent !== record.transactionHash)
    throw new OwnerSafetyError(
      "RPC returned a different transaction identity; retain and reconcile the saved hash",
    );
  record.phase = "broadcast";
  writePrivate(journalPath, record);
  console.log(
    `Owner submitted ${sent}. Waiting for the receipt; no other transaction will be sent.`,
  );
  phase = "receipt verification";
  await verifyReceipt(record, true);
}
main().catch((error) => {
  console.error(
    `Stopped during ${phase}: ${error instanceof Error ? error.name : "UnknownError"}.`,
  );
  if (error instanceof OwnerSafetyError) console.error(error.message);
  console.error(
    "No success is assumed. Keep the owner journal; --status is read-only and never resends. Inspect the terminal context before another action.",
  );
  process.exitCode = 1;
});
