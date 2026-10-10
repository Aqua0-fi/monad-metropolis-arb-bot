import {
  readFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  constants,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createPublicClient,
  http,
  keccak256,
  serializeTransaction,
  getAddress,
  formatEther,
  type Address,
  type Hex,
  type Abi,
} from "viem";
import { loadChains } from "../src/config.js";
import { createOwnerCallAccount } from "../src/kms-account.js";
import {
  pilotPolicySchema,
  readPilotState,
  setupSteps,
  fundingStep,
  unpauseStep,
  pilotExecutionConfig,
  type OwnerStep,
} from "../src/owner-pilot.js";

const root = resolve(import.meta.dirname, "..");
process.chdir(root);
const { values } = parseArgs({
  options: {
    enable: { type: "boolean", default: false },
    status: { type: "boolean", default: false },
  },
});
if (values.enable && values.status)
  throw Error("Choose enable or status, not both");
const configPath = resolve("config/arbitrum-pilot.json");
const configBytes = readFileSync(configPath);
const policy = pilotPolicySchema.parse(JSON.parse(configBytes.toString()));
const policyHash = createHash("sha256").update(configBytes).digest("hex");
const chain = loadChains().find((c) => c.chainId === 42161)!;
const artifact = JSON.parse(
  readFileSync("out/MarketRebalancer.sol/MarketRebalancer.json", "utf8"),
);
const client = createPublicClient({
  transport: http("https://arb1.arbitrum.io/rpc", {
    timeout: 15000,
    retryCount: 1,
  }),
});
const journalPath = resolve("runtime/owner-launch/arbitrum-pilot.json");
const releasePath = resolve("runtime/owner-launch/arbitrum-pilot-release.json");
const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
type StepReceipt = {
  id: string;
  to: Address;
  data: Hex;
  value: string;
  nonce: number;
  gas: string;
  gasPrice: string;
  unsignedHash: Hex;
  phase: "prepared" | "signed" | "broadcast" | "confirmed" | "reverted";
  hash?: Hex;
  blockHash?: Hex;
  blockNumber?: string;
  actualFeeWei?: string;
};
type Journal = {
  version: 1;
  chainId: 42161;
  owner: Address;
  executor: Address;
  policyHash: string;
  phase: string;
  steps: StepReceipt[];
};
let journal: Journal | undefined;
function privateWrite(path: string, value: unknown) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (
    lstatSync(parent).isSymbolicLink() ||
    (existsSync(path) && lstatSync(path).isSymbolicLink())
  )
    throw Error("Unsafe owner journal path");
  const tmp = path + ".new";
  const fd = openSync(
    tmp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    const bytes = Buffer.from(json(value) + "\n");
    let offset = 0;
    while (offset < bytes.length) {
      offset += requireWrite(fd, bytes.subarray(offset));
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dir = openSync(parent, constants.O_RDONLY);
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
// A named import avoids an alternate shell/file-writing path for persistence.
import { writeSync as requireWrite } from "node:fs";
function save() {
  if (!journal) throw Error("Missing owner journal");
  privateWrite(journalPath, journal);
}
function loadJournal() {
  if (!existsSync(journalPath)) return;
  const s = lstatSync(journalPath);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    (s.mode & 0o077) !== 0 ||
    s.size > 131072
  )
    throw Error("Unsafe owner journal");
  const j = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  if (
    j.version !== 1 ||
    j.chainId !== 42161 ||
    j.owner !== policy.owner ||
    j.executor !== policy.executor ||
    j.policyHash !== policyHash ||
    !Array.isArray(j.steps)
  )
    throw Error("Owner journal scope differs; preserve it for manual review");
  const ids = new Set<string>();
  for (const step of j.steps) {
    if (
      ids.has(step.id) ||
      !Number.isSafeInteger(step.nonce) ||
      step.nonce < 0 ||
      !/^0x[0-9a-fA-F]{64}$/.test(step.unsignedHash) ||
      (step.hash && !/^0x[0-9a-fA-F]{64}$/.test(step.hash))
    )
      throw Error("Invalid owner journal entry");
    ids.add(step.id);
  }
  journal = j;
}
async function remote(action: string, extra: Record<string, unknown> = {}) {
  if (!existsSync(releasePath))
    throw Error(
      "The verified observer release receipt is not present yet; do not enable an unverified image",
    );
  const release = JSON.parse(readFileSync(releasePath, "utf8"));
  if (
    !/^sha256:[0-9a-f]{64}$/.test(release.image) ||
    release.tradingEnabled !== false
  )
    throw Error("Invalid observer release receipt");
  const source = readFileSync("ops/owner-pilot-remote.py", "utf8");
  const escaped = "'" + source.replaceAll("'", "'\\''") + "'";
  const payload = {
    action,
    policy: { ...JSON.parse(json(policy)), image: release.image },
    ...extra,
  };
  return await new Promise<any>((accept, reject) => {
    const child = spawn(
      "ssh",
      [
        "-i",
        "/Users/rithikkumars/Downloads/AWS-Ubuntu-KP1.pem",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=8",
        "ubuntu@18.207.103.187",
        "sudo -n python3 -c " + escaped,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "",
      error = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        Error("Owner host action is uncertain; check status before retrying"),
      );
    }, 240000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.length > 131072) {
        child.kill();
        reject(Error("Oversized host result"));
      }
    });
    child.stderr.on("data", (chunk) => {
      error += chunk;
      if (error.length > 32768) {
        child.kill();
        reject(Error("Oversized host error"));
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(Error("Could not invoke the existing SSH owner connection"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        let reason = "Owner host action failed; no completion is assumed";
        try {
          reason = JSON.parse(error.trim()).error ?? reason;
        } catch {}
        reject(Error(reason));
        return;
      }
      try {
        accept(JSON.parse(out.trim()));
      } catch {
        reject(Error("Unparseable owner host result"));
      }
    });
    child.stdin.end(json(payload));
  });
}
async function verifyRecorded(record: StepReceipt, wait: boolean) {
  if (!record.hash)
    throw Error(
      "An earlier signing intent has no saved transaction hash. Do not delete it or repeat it; inspect the owner journal",
    );
  const receipt = wait
    ? await client.waitForTransactionReceipt({
        hash: record.hash,
        confirmations: 2,
        timeout: 120000,
        pollingInterval: 1000,
      })
    : await client.getTransactionReceipt({ hash: record.hash });
  if (receipt.status !== "success") {
    record.phase = "reverted";
    save();
    throw Error(
      "An owner setup transaction reverted; stop and inspect its receipt before any retry",
    );
  }
  const tx = await client.getTransaction({ hash: record.hash });
  if (
    getAddress(tx.from) !== policy.owner ||
    !tx.to ||
    getAddress(tx.to) !== getAddress(record.to) ||
    tx.nonce !== record.nonce ||
    tx.value !== BigInt(record.value) ||
    tx.input.toLowerCase() !== record.data.toLowerCase() ||
    tx.chainId !== 42161
  )
    throw Error("Saved transaction differs from the owner-reviewed call");
  if (
    (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !==
      receipt.blockHash ||
    (await client.getBlockNumber()) < receipt.blockNumber + 1n
  )
    throw Error("Owner receipt is not yet canonical and confirmed");
  record.phase = "confirmed";
  record.blockHash = receipt.blockHash;
  record.blockNumber = String(receipt.blockNumber);
  record.actualFeeWei = String(receipt.gasUsed * receipt.effectiveGasPrice);
  save();
}
async function sendStep(step: OwnerStep) {
  const prior = journal!.steps.find((x) => x.id === step.id);
  if (prior) {
    await verifyRecorded(prior, true);
    return;
  }
  if (step.to !== policy.executor && step.to !== policy.fundingRouter)
    throw Error("Owner setup target is outside the reviewed scope");
  if (step.to === policy.executor && step.value !== 0n)
    throw Error("Never send ETH directly to the executor");
  if (step.value > policy.maxFundingEthWei)
    throw Error("Funding exceeds the owner cap");
  const block = await client.getBlock();
  if (step.deadline && step.deadline <= block.timestamp + 15n)
    throw Error("Funding quote is too close to expiry; no signing occurred");
  const nonce = await client.getTransactionCount({
    address: policy.owner,
    blockTag: "pending",
  });
  if (
    nonce !==
    (await client.getTransactionCount({
      address: policy.owner,
      blockTag: "latest",
    }))
  )
    throw Error("The owner wallet already has a pending transaction");
  const gasPrice = ((await client.getGasPrice()) * 10500n + 9999n) / 10000n;
  if (gasPrice <= 0n || gasPrice > policy.maxFeePerGas)
    throw Error("Current gas exceeds the explicit owner ceiling");
  const gas = await client.estimateGas({
    account: policy.owner,
    to: step.to,
    data: step.data,
    value: step.value,
    gasPrice,
    nonce,
  });
  if (gas <= 0n || gas > policy.maxGasUnits)
    throw Error("Owner setup gas estimate exceeds its ceiling");
  const spent = journal!.steps.reduce(
    (sum, x) =>
      sum +
      BigInt(x.actualFeeWei ?? String(BigInt(x.gas) * BigInt(x.gasPrice))),
    0n,
  );
  if (spent + gas * gasPrice > policy.maxSetupFeeWei)
    throw Error("Owner setup gas budget is exhausted");
  if (
    (await client.getBalance({ address: policy.owner })) <
    step.value + gas * gasPrice + policy.maxDailyGasWei
  )
    throw Error("Insufficient balance after retaining the pilot's gas reserve");
  const tx = {
    type: "legacy" as const,
    chainId: 42161,
    to: step.to,
    data: step.data,
    value: step.value,
    gas,
    gasPrice,
    nonce,
  };
  const unsignedHash = keccak256(serializeTransaction(tx));
  const account = await createOwnerCallAccount(
    {
      address: policy.owner,
      chainId: 42161,
      target: step.to,
      keyId: process.env.MARKET_REBALANCER_KMS_KEY_ID!,
      region: process.env.AWS_REGION!,
    },
    unsignedHash,
  );
  const entry: StepReceipt = {
    id: step.id,
    to: step.to,
    data: step.data,
    value: String(step.value),
    gas: String(gas),
    gasPrice: String(gasPrice),
    nonce,
    unsignedHash,
    phase: "prepared",
  };
  journal!.steps.push(entry);
  save();
  const raw = await account.signTransaction(tx);
  entry.hash = keccak256(raw);
  entry.phase = "signed";
  save();
  console.log(
    json({
      step: step.id,
      transactionHash: entry.hash,
      estimatedGasEth: formatEther(gas * gasPrice),
    }),
  );
  await client.sendRawTransaction({ serializedTransaction: raw });
  entry.phase = "broadcast";
  save();
  await verifyRecorded(entry, true);
}
async function main() {
  if (values.enable && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw Error("Live setup requires the owner at an interactive terminal");
  if (
    values.enable &&
    (getAddress(
      process.env.MARKET_REBALANCER_OPERATOR_ADDRESS ??
        "0x0000000000000000000000000000000000000000",
    ) !== policy.owner ||
      !process.env.MARKET_REBALANCER_KMS_KEY_ID ||
      !process.env.AWS_REGION)
  )
    throw Error("The dedicated owner KMS configuration is not loaded");
  loadJournal();
  let snapshot = await readPilotState(client, policy, chain, artifact);
  const funding = await fundingStep(client, policy, snapshot);
  const host = existsSync(releasePath) ? await remote("preflight") : null;
  console.log(
    json({
      chainId: 42161,
      owner: policy.owner,
      executor: policy.executor,
      ownerEth: formatEther(snapshot.ownerEth),
      executorUsdcRaw: String(snapshot.inventory),
      paused: snapshot.paused,
      host,
      setupSteps: setupSteps(policy, snapshot).map((s) => s.description),
      funding: funding
        ? {
            description: funding.description,
            maximumEth: formatEther(funding.value),
            deadline: String(funding.deadline),
          }
        : null,
      maxTradeUsdc: "5",
      minimumNetProfitUsdc: "0.01",
      gasMargin: "5% above live gas price",
      maximumDailyGasEth: formatEther(policy.maxDailyGasWei),
      maximumSetupGasEth: formatEther(policy.maxSetupFeeWei),
      gasPriceCeilingWei: String(policy.maxFeePerGas),
      maxGasUnits: String(policy.maxGasUnits),
      profitRecipient: policy.executor,
      automaticWithdrawals: false,
      automaticLpReturns: false,
      signatures: 0,
    }),
  );
  if (!values.enable) return;
  if (!host)
    throw Error(
      "The new observer image has not been verified and recorded; setup was not started",
    );
  if (host.mode === "execute" && host.executionEnabled) {
    console.log(
      "The Arbitrum pilot is already active; no setup or funding was repeated.",
    );
    return;
  }
  if (journal?.steps.some((s) => s.phase !== "confirmed")) {
    for (const step of journal.steps.filter((s) => s.phase !== "confirmed"))
      await verifyRecorded(step, true);
  }
  const confirmation = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let answer: string;
  try {
    answer = await confirmation.question(
      "This configures the existing executor, buys up to 5 USDC using your ETH, and enables one Arbitrum route. Profits remain in the executor. Type START ARBITRUM 5 USDC to proceed: ",
    );
  } finally {
    confirmation.close();
  }
  if (answer !== "START ARBITRUM 5 USDC")
    throw Error("Owner did not confirm; no transaction was signed");
  if (!journal) {
    journal = {
      version: 1,
      chainId: 42161,
      owner: policy.owner,
      executor: policy.executor,
      policyHash,
      phase: "owner_confirmed",
      steps: [],
    };
    save();
  }
  const execution = pilotExecutionConfig(
    policy,
    {
      region: process.env.AWS_REGION!,
      keyId: process.env.MARKET_REBALANCER_KMS_KEY_ID!,
    },
    snapshot.externalFee,
  );
  const credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    ...(process.env.AWS_SESSION_TOKEN
      ? { sessionToken: process.env.AWS_SESSION_TOKEN }
      : {}),
  };
  journal.phase = "staging_host";
  save();
  console.log(
    json(
      await remote("stage", {
        ownerConfirmation: answer,
        execution,
        credentials,
      }),
    ),
  );
  journal.phase = "onchain_setup";
  save();
  snapshot = await readPilotState(client, policy, chain, artifact);
  for (const step of setupSteps(policy, snapshot)) await sendStep(step);
  snapshot = await readPilotState(client, policy, chain, artifact);
  const buy = await fundingStep(client, policy, snapshot);
  if (buy) await sendStep(buy);
  snapshot = await readPilotState(client, policy, chain, artifact);
  if (
    setupSteps(policy, snapshot).length ||
    snapshot.inventory < policy.inventoryTarget
  )
    throw Error(
      "Onchain setup or confirmed inventory is incomplete; trading stays off",
    );
  if (snapshot.paused) await sendStep(unpauseStep(policy));
  snapshot = await readPilotState(client, policy, chain, artifact);
  if (
    snapshot.paused ||
    setupSteps(policy, snapshot).length ||
    snapshot.inventory < policy.maxInput
  )
    throw Error("Final onchain verification failed; worker is not activated");
  journal.phase = "activating_worker";
  save();
  const active = await remote("activate", {
    ownerConfirmation: answer,
    execution,
    onchainVerified: true,
  });
  journal.phase = "active";
  save();
  console.log(
    json({
      ...active,
      ownerSetupTransactions: journal.steps.map((s) => s.hash),
      dashboard: "https://staging-admin.aqua0.xyz/?section=market-rebalancer",
      note: "A live worker can remain idle when current spreads do not cover measured costs. No profit is claimed until a canonical receipt is recorded.",
    }),
  );
}
let lock: number | undefined;
let lockPath: string | undefined;
try {
  if (values.enable) {
    mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
    lockPath = journalPath + ".lock";
    lock = openSync(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
  }
  await main();
} catch (error) {
  console.error(
    "Owner pilot stopped:",
    error instanceof Error ? error.message : "Unknown error",
  );
  console.error(
    "Keep the owner journal. A saved or uncertain transaction must be checked before any retry.",
  );
  process.exitCode = 1;
} finally {
  if (lock !== undefined) {
    closeSync(lock);
    unlinkSync(lockPath!);
  }
}
