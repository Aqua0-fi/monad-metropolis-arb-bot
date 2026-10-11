import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createPublicKey } from "node:crypto";
import { dirname } from "node:path";
import {
  getAddress,
  keccak256,
  serializeTransaction,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import {
  awsKmsTransport,
  createOwnerCallAccount,
  createOwnerDeploymentAccount,
  type KmsTransport,
} from "./kms-account.js";

/** A refusal raised before any signature. Messages never include secret values. */
export class OwnerSafetyError extends Error {
  override name = "OwnerSafetyError";
}

export const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );

// ---------------------------------------------------------------------------
// Private, atomic, fsynced owner files (mode 600 in a mode 700 directory).
// ---------------------------------------------------------------------------
export function privateDirectory(folder: string) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  let s = lstatSync(folder);
  // The worker may create runtime/monad-pilot first (for its budget ledger); tighten our own directory.
  if (
    s.isDirectory() &&
    !s.isSymbolicLink() &&
    s.uid === process.getuid?.() &&
    (s.mode & 0o077) !== 0
  ) {
    chmodSync(folder, 0o700);
    s = lstatSync(folder);
  }
  if (
    s.isSymbolicLink() ||
    !s.isDirectory() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o077) !== 0
  )
    throw new OwnerSafetyError(
      `Unsafe owner state directory ${folder}; it must be a private (700) directory owned by you`,
    );
}
export function writePrivateFile(path: string, value: unknown) {
  const parent = dirname(path);
  privateDirectory(parent);
  if (existsSync(path)) {
    const s = lstatSync(path);
    if (
      s.isSymbolicLink() ||
      !s.isFile() ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o077) !== 0
    )
      throw new OwnerSafetyError(`Unsafe owner record ${path}`);
  }
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    const bytes = Buffer.from(
      (typeof value === "string" ? value : json(value)) + "\n",
    );
    let offset = 0;
    while (offset < bytes.length)
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const dir = openSync(parent, constants.O_RDONLY);
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
export function readPrivateJson<T>(path: string, maxBytes = 1_048_576): T {
  const s = lstatSync(path);
  if (
    s.isSymbolicLink() ||
    !s.isFile() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o077) !== 0 ||
    s.size > maxBytes
  )
    throw new OwnerSafetyError(`Unsafe owner record ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Exclusive owner lock. A lock left by a dead process is reclaimed so the safety close can always run. */
export function acquireOwnerLock(path: string): () => void {
  privateDirectory(dirname(path));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          /* already released */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder = 0;
      try {
        holder = Number(readFileSync(path, "utf8").trim());
      } catch {
        /* unreadable lock: treat as held */
      }
      let alive = true;
      if (Number.isSafeInteger(holder) && holder > 0) {
        try {
          process.kill(holder, 0);
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code === "EPERM";
        }
      }
      if (alive)
        throw new OwnerSafetyError(
          `Another owner command (pid ${holder || "unknown"}) holds ${path}; wait for it to finish`,
        );
      unlinkSync(path);
    }
  }
  throw new OwnerSafetyError(`Could not acquire ${path}`);
}

// ---------------------------------------------------------------------------
// RPC and signer guards.
// ---------------------------------------------------------------------------
export const FREE_MONAD_RPC_HOSTS = new Set([
  "rpc.monad.xyz",
  "rpc1.monad.xyz",
  "rpc2.monad.xyz",
  "rpc3.monad.xyz",
  "rpc-mainnet.monadinfra.com",
]);
export const DEFAULT_MONAD_RPC = "https://rpc2.monad.xyz";
export const DEFAULT_ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";
/** The backend's PAID endpoint shares this name. Owner tooling never reads it as a default. */
export const PAID_MONAD_RPC_ENV = "RPC_URL_MAINNET_MONAD";

export function isLoopbackRpc(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
/** Accept only known free public Monad endpoints or a loopback fork. Never the paid env endpoint. */
export function assertFreeMonadRpc(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OwnerSafetyError("Invalid RPC URL");
  }
  const paid = env[PAID_MONAD_RPC_ENV];
  if (
    paid &&
    paid.trim().replace(/\/+$/, "") === url.trim().replace(/\/+$/, "")
  )
    throw new OwnerSafetyError(
      `The RPC equals ${PAID_MONAD_RPC_ENV}, which is the backend's paid endpoint; use a free endpoint`,
    );
  if (isLoopbackRpc(url)) return url;
  if (
    parsed.protocol !== "https:" ||
    !FREE_MONAD_RPC_HOSTS.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search
  )
    throw new OwnerSafetyError(
      `RPC host is not on the free Monad allowlist (${[...FREE_MONAD_RPC_HOSTS].join(", ")}) or a 127.0.0.1 fork`,
    );
  return url;
}

export type OwnerSignerMode = "kms" | "anvil-test";
/** Test-only identity. Anvil's public development mnemonic; refused for anything but a 127.0.0.1 anvil. */
const ANVIL_DEV_MNEMONIC =
  "test test test test test test test test test test test junk";
export const TEST_SIGNER_KEY_ID =
  "arn:aws:kms:us-east-1:000000000000:key/00000000-0000-4000-8000-000000000000";
export const TEST_SIGNER_REGION = "us-east-1";

export function anvilTestAccount() {
  return mnemonicToAccount(ANVIL_DEV_MNEMONIC, { addressIndex: 0 });
}
/** A KmsTransport-shaped local signer so test runs exercise the same one-use, digest-bound signer code. */
export function anvilTestTransport(): KmsTransport {
  const wallet = anvilTestAccount();
  const point = Buffer.from(wallet.publicKey.slice(4), "hex");
  const der = createPublicKey({
    key: {
      kty: "EC",
      crv: "secp256k1",
      x: point.subarray(0, 32).toString("base64url"),
      y: point.subarray(32).toString("base64url"),
    },
    format: "jwk",
  }).export({ format: "der", type: "spki" });
  const integer = (hex: string) => {
    let bytes = Buffer.from(hex, "hex");
    while (bytes.length > 1 && bytes[0] === 0 && !(bytes[1]! & 128))
      bytes = bytes.subarray(1);
    if (bytes[0]! & 128) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([2, bytes.length]), bytes]);
  };
  return {
    async publicKey(keyId) {
      if (keyId !== TEST_SIGNER_KEY_ID)
        throw new Error("Unexpected test key id");
      return {
        keyId,
        keySpec: "ECC_SECG_P256K1",
        keyUsage: "SIGN_VERIFY",
        der,
      };
    },
    async signDigest(keyId, digest) {
      if (keyId !== TEST_SIGNER_KEY_ID || digest.length !== 32)
        throw new Error("Invalid test digest request");
      const signature = await wallet.sign({
        hash: `0x${Buffer.from(digest).toString("hex")}`,
      });
      const values = Buffer.concat([
        integer(signature.slice(2, 66)),
        integer(signature.slice(66, 130)),
      ]);
      return {
        keyId,
        algorithm: "ECDSA_SHA_256",
        der: Buffer.concat([Buffer.from([0x30, values.length]), values]),
      };
    },
  };
}
/** Test signer refuses unless the RPC is exactly a 127.0.0.1 anvil node. */
export async function assertAnvilTestTarget(client: PublicClient, url: string) {
  if (!isLoopbackRpc(url))
    throw new OwnerSafetyError(
      "The anvil-test signer only runs against http://127.0.0.1 (a local anvil fork)",
    );
  const version = (await client.request({
    method: "web3_clientVersion",
  } as never)) as string;
  if (
    typeof version !== "string" ||
    !version.toLowerCase().startsWith("anvil/")
  )
    throw new OwnerSafetyError(
      "The anvil-test signer requires a local anvil node",
    );
}

export interface OwnerIdentity {
  mode: OwnerSignerMode;
  address: Address;
  keyId: string;
  region: string;
  transport: KmsTransport;
}
/** Resolve the owner signer. KMS reads only env names; values are never printed. */
export async function ownerIdentity(
  mode: OwnerSignerMode,
  client: PublicClient,
  rpcUrl: string,
  expectedOwner: Address,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OwnerIdentity> {
  if (mode === "anvil-test") {
    await assertAnvilTestTarget(client, rpcUrl);
    return {
      mode,
      address: anvilTestAccount().address,
      keyId: TEST_SIGNER_KEY_ID,
      region: TEST_SIGNER_REGION,
      transport: anvilTestTransport(),
    };
  }
  const keyId = env.MARKET_REBALANCER_KMS_KEY_ID ?? "";
  const region = env.AWS_REGION ?? "";
  let configured: Address;
  try {
    configured = getAddress(env.MARKET_REBALANCER_OPERATOR_ADDRESS ?? "");
  } catch {
    throw new OwnerSafetyError(
      "The dedicated owner KMS configuration is not loaded (MARKET_REBALANCER_OPERATOR_ADDRESS)",
    );
  }
  if (!keyId || !region)
    throw new OwnerSafetyError(
      "The dedicated owner KMS configuration is not loaded (AWS_REGION / MARKET_REBALANCER_KMS_KEY_ID)",
    );
  if (configured !== getAddress(expectedOwner))
    throw new OwnerSafetyError(
      "The loaded KMS wallet is not the reviewed owner in the Monad policy",
    );
  return {
    mode,
    address: configured,
    keyId,
    region,
    transport: awsKmsTransport(region),
  };
}

// ---------------------------------------------------------------------------
// Journal: intent before signing, hash before broadcast, never a blind retry.
// ---------------------------------------------------------------------------
export type TxPhase =
  | "prepared"
  | "signed"
  | "broadcast"
  | "confirmed"
  | "reverted"
  | "abandoned"
  | "superseded";
export interface TxRecord {
  id: string;
  description: string;
  kind: "call" | "create";
  to: Address | null;
  data: Hex;
  value: string;
  nonce: number;
  gas: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  unsignedHash: Hex;
  phase: TxPhase;
  hash?: Hex;
  raw?: Hex;
  blockNumber?: string;
  blockHash?: Hex;
  contractAddress?: Address;
  chargedFeeWei?: string;
  note?: string;
  createdAt: string;
}
export interface JournalFile {
  version: 1;
  chainId: number;
  owner: Address;
  scope: string;
  records: TxRecord[];
  meta: Record<string, unknown>;
}
export class OwnerJournal {
  data: JournalFile;
  constructor(
    readonly path: string,
    identity: { chainId: number; owner: Address; scope: string },
  ) {
    if (existsSync(path)) {
      const j = readPrivateJson<JournalFile>(path);
      if (
        j.version !== 1 ||
        j.chainId !== identity.chainId ||
        getAddress(j.owner) !== getAddress(identity.owner) ||
        j.scope !== identity.scope ||
        !Array.isArray(j.records)
      )
        throw new OwnerSafetyError(
          `Owner journal ${path} belongs to a different chain, owner or scope; preserve it for manual review`,
        );
      const ids = new Set<string>();
      for (const r of j.records) {
        if (
          ids.has(r.id) ||
          !Number.isSafeInteger(r.nonce) ||
          r.nonce < 0 ||
          !/^0x[0-9a-fA-F]{64}$/.test(r.unsignedHash) ||
          (r.hash && !/^0x[0-9a-fA-F]{64}$/.test(r.hash))
        )
          throw new OwnerSafetyError(`Invalid owner journal entry in ${path}`);
        ids.add(r.id);
      }
      this.data = j;
    } else {
      this.data = {
        version: 1,
        chainId: identity.chainId,
        owner: getAddress(identity.owner),
        scope: identity.scope,
        records: [],
        meta: {},
      };
    }
  }
  get exists() {
    return existsSync(this.path);
  }
  find(id: string) {
    return this.data.records.find((r) => r.id === id);
  }
  unresolved() {
    return this.data.records.filter(
      (r) =>
        r.phase !== "confirmed" &&
        r.phase !== "abandoned" &&
        r.phase !== "superseded",
    );
  }
  save() {
    writePrivateFile(this.path, this.data);
  }
  spentWei(prefix = ""): bigint {
    return this.data.records
      .filter((r) => r.id.startsWith(prefix) && r.phase !== "abandoned")
      .reduce(
        (sum, r) =>
          sum +
          BigInt(
            r.chargedFeeWei ??
              String(
                BigInt(r.gas) * BigInt(r.gasPrice ?? r.maxFeePerGas ?? "0"),
              ),
          ),
        0n,
      );
  }
}

export interface GasPolicy {
  /** Highest legacy gas price / EIP-1559 max fee this command may sign. */
  maxFeePerGas: bigint;
  priorityFeeWei: bigint;
  /** Multiplier on the live price, in basis points (10000 = 1x). */
  priceMarginBps: bigint;
  /** Multiplier on the gas estimate; Monad charges the full limit, so keep it small. */
  gasMarginBps: bigint;
  maxGas: bigint;
}
export async function livePrice(client: PublicClient, policy: GasPolicy) {
  const [gasPrice, block] = await Promise.all([
    client.getGasPrice(),
    client.getBlock(),
  ]);
  const floor = (block.baseFeePerGas ?? 0n) + policy.priorityFeeWei;
  const base = gasPrice > floor ? gasPrice : floor;
  const price = (base * policy.priceMarginBps + 9999n) / 10000n;
  return { price, baseFee: block.baseFeePerGas ?? 0n, rpcGasPrice: gasPrice };
}
/** Monad charges gasLimit * price; elsewhere gasUsed * price. Conservative and exact for receipts. */
export function chargedFee(
  chainId: number,
  gasLimit: bigint,
  gasUsed: bigint,
  effectiveGasPrice: bigint,
) {
  return (chainId === 143 ? gasLimit : gasUsed) * effectiveGasPrice;
}

export interface OwnerCallStep {
  id: string;
  description: string;
  to: Address;
  data: Hex;
  value: bigint;
}
export type ReconcileMode = "strict" | "close";
export interface SendContext {
  client: PublicClient;
  journal: OwnerJournal;
  chainId: number;
  identity: OwnerIdentity;
  gas: GasPolicy;
  allowedTargets: Address[];
  /** Total fee budget for every record whose id starts with budgetPrefix (undefined = no command budget). */
  budgetWei?: bigint;
  budgetPrefix?: string;
  /** Minimum native balance that must remain after this call's maximum fee. */
  reserveWei?: bigint;
  mode: ReconcileMode;
  receiptTimeoutMs?: number;
  log?: (line: string) => void;
}

async function waitForReceipt(ctx: SendContext, hash: Hex) {
  return ctx.client.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: ctx.receiptTimeoutMs ?? 90_000,
    pollingInterval: 1000,
  });
}
async function verifyLanded(ctx: SendContext, record: TxRecord) {
  const receipt = await waitForReceipt(ctx, record.hash!);
  const tx = await ctx.client.getTransaction({ hash: record.hash! });
  if (
    getAddress(tx.from) !== getAddress(ctx.identity.address) ||
    tx.nonce !== record.nonce ||
    tx.value !== BigInt(record.value) ||
    tx.input.toLowerCase() !== record.data.toLowerCase() ||
    (record.to === null
      ? tx.to !== null && tx.to !== undefined
      : !tx.to || getAddress(tx.to) !== getAddress(record.to))
  )
    throw new OwnerSafetyError(
      `Saved transaction ${record.id} differs from the owner-reviewed call; preserve the journal`,
    );
  const block = await ctx.client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash)
    throw new OwnerSafetyError(`Receipt for ${record.id} is not canonical yet`);
  record.blockNumber = String(receipt.blockNumber);
  record.blockHash = receipt.blockHash;
  record.chargedFeeWei = String(
    chargedFee(ctx.chainId, tx.gas, receipt.gasUsed, receipt.effectiveGasPrice),
  );
  if (receipt.contractAddress)
    record.contractAddress = getAddress(receipt.contractAddress);
  if (receipt.status !== "success") {
    record.phase = "reverted";
    ctx.journal.save();
    if (ctx.mode === "strict")
      throw new OwnerSafetyError(
        `Owner transaction ${record.id} reverted (${record.hash}); inspect it before any retry`,
      );
    return record;
  }
  record.phase = "confirmed";
  ctx.journal.save();
  ctx.log?.(
    `confirmed ${record.id} ${record.hash} in block ${receipt.blockNumber}`,
  );
  return record;
}

/**
 * Reconcile an existing record without creating a new transaction. With a saved raw transaction and an
 * unused nonce, only the IDENTICAL signed bytes are rebroadcast (same hash); that is never a new spend.
 */
export async function reconcileRecord(
  ctx: SendContext,
  record: TxRecord,
): Promise<TxRecord> {
  if (
    record.phase === "confirmed" ||
    record.phase === "abandoned" ||
    record.phase === "superseded"
  )
    return record;
  if (record.phase === "reverted") {
    if (ctx.mode === "strict")
      throw new OwnerSafetyError(
        `Owner transaction ${record.id} reverted earlier; inspect it before any retry`,
      );
    return record;
  }
  if (!record.hash) {
    // The hash is persisted before every broadcast, so a hash-less intent was never transmitted.
    if (ctx.mode === "close") {
      record.phase = "abandoned";
      record.note = "intent without a saved hash was never broadcast";
      ctx.journal.save();
      return record;
    }
    throw new OwnerSafetyError(
      `An earlier signing intent (${record.id}) has no saved transaction hash. Do not delete the journal; review it manually`,
    );
  }
  let known = false;
  try {
    await ctx.client.getTransactionReceipt({ hash: record.hash });
    known = true;
  } catch {
    try {
      await ctx.client.getTransaction({ hash: record.hash });
      known = true;
    } catch {
      known = false;
    }
  }
  if (!known) {
    const latest = await ctx.client.getTransactionCount({
      address: ctx.identity.address,
      blockTag: "latest",
    });
    if (latest > record.nonce) {
      record.phase = "superseded";
      record.note = "nonce consumed by a different transaction";
      ctx.journal.save();
      if (ctx.mode === "strict")
        throw new OwnerSafetyError(
          `The nonce of ${record.id} was consumed by another transaction; review before continuing`,
        );
      return record;
    }
    if (ctx.mode === "close" && !record.id.startsWith("close:")) {
      // The safety close never re-sends a non-close intent; an unknown hash with an unused nonce was not accepted.
      record.phase = "abandoned";
      record.note =
        "unknown to the RPC with an unused nonce; not rebroadcast by the safety close";
      ctx.journal.save();
      return record;
    }
    if (!record.raw)
      throw new OwnerSafetyError(
        `${record.id} is unknown to the RPC and its signed bytes were not saved; review manually`,
      );
    ctx.log?.(
      `rebroadcasting identical signed bytes for ${record.id} (${record.hash})`,
    );
    const sent = await ctx.client.sendRawTransaction({
      serializedTransaction: record.raw,
    });
    if (sent.toLowerCase() !== record.hash.toLowerCase())
      throw new OwnerSafetyError(
        "RPC returned a different transaction identity; retain and reconcile the saved hash",
      );
    record.phase = "broadcast";
    ctx.journal.save();
  }
  return verifyLanded(ctx, record);
}

async function waitForNoPending(ctx: SendContext) {
  for (let i = 0; i < 40; i++) {
    const [pending, latest] = await Promise.all([
      ctx.client.getTransactionCount({
        address: ctx.identity.address,
        blockTag: "pending",
      }),
      ctx.client.getTransactionCount({
        address: ctx.identity.address,
        blockTag: "latest",
      }),
    ]);
    if (pending === latest) return pending;
    if (ctx.mode === "strict")
      throw new OwnerSafetyError(
        "The owner wallet already has a pending transaction; wait for it before another owner action",
      );
    await new Promise((r) => setTimeout(r, 500));
  }
  // Close path: queue behind whatever is pending rather than never closing.
  return ctx.client.getTransactionCount({
    address: ctx.identity.address,
    blockTag: "pending",
  });
}

/** Journaled, KMS one-use, exact-bytes owner call. */
export async function sendOwnerCall(
  ctx: SendContext,
  step: OwnerCallStep,
): Promise<TxRecord> {
  const prior = ctx.journal.find(step.id);
  if (prior) return reconcileRecord(ctx, prior);
  if (!ctx.allowedTargets.some((t) => getAddress(t) === getAddress(step.to)))
    throw new OwnerSafetyError(
      `Owner call target ${step.to} is outside the reviewed scope`,
    );
  if (ctx.chainId === 143 && step.value !== 0n)
    throw new OwnerSafetyError("Monad owner calls never send MON");
  if ((await ctx.client.getChainId()) !== ctx.chainId)
    throw new OwnerSafetyError("RPC chain changed");
  const nonce = await waitForNoPending(ctx);
  const { price } = await livePrice(ctx.client, ctx.gas);
  if (price <= 0n || price > ctx.gas.maxFeePerGas)
    throw new OwnerSafetyError(
      `Current gas price ${price} wei exceeds this command's ceiling ${ctx.gas.maxFeePerGas} wei; nothing was signed`,
    );
  const estimate = await ctx.client.estimateGas({
    account: ctx.identity.address,
    to: step.to,
    data: step.data,
    value: step.value,
  });
  const gas = (estimate * ctx.gas.gasMarginBps + 9999n) / 10000n;
  if (gas <= 0n || gas > ctx.gas.maxGas)
    throw new OwnerSafetyError(
      `Gas estimate for ${step.id} exceeds its ${ctx.gas.maxGas} ceiling; nothing was signed`,
    );
  const maximumFee = gas * price;
  if (
    ctx.budgetWei !== undefined &&
    ctx.journal.spentWei(ctx.budgetPrefix ?? "") + maximumFee > ctx.budgetWei
  )
    throw new OwnerSafetyError(
      `The owner gas budget for this command is exhausted; ${step.id} was not signed`,
    );
  const balance = await ctx.client.getBalance({
    address: ctx.identity.address,
  });
  if (balance < step.value + maximumFee + (ctx.reserveWei ?? 0n))
    throw new OwnerSafetyError(
      `Owner native balance cannot cover ${step.id} plus the retained reserve; nothing was signed`,
    );
  const tx = {
    type: "legacy" as const,
    chainId: ctx.chainId,
    to: step.to,
    data: step.data,
    value: step.value,
    gas,
    gasPrice: price,
    nonce,
  };
  const unsignedHash = keccak256(serializeTransaction(tx));
  const account: LocalAccount = await createOwnerCallAccount(
    {
      address: ctx.identity.address,
      chainId: ctx.chainId,
      target: step.to,
      keyId: ctx.identity.keyId,
      region: ctx.identity.region,
    },
    unsignedHash,
    ctx.identity.transport,
  );
  const record: TxRecord = {
    id: step.id,
    description: step.description,
    kind: "call",
    to: step.to,
    data: step.data,
    value: String(step.value),
    nonce,
    gas: String(gas),
    gasPrice: String(price),
    unsignedHash,
    phase: "prepared",
    createdAt: new Date().toISOString(),
  };
  ctx.journal.data.records.push(record);
  ctx.journal.save();
  const raw = await account.signTransaction(tx);
  record.hash = keccak256(raw);
  record.raw = raw;
  record.phase = "signed";
  ctx.journal.save();
  ctx.log?.(`signed ${step.id} ${record.hash} (max fee ${maximumFee} wei)`);
  const sent = await ctx.client.sendRawTransaction({
    serializedTransaction: raw,
  });
  if (sent.toLowerCase() !== record.hash.toLowerCase())
    throw new OwnerSafetyError(
      "RPC returned a different transaction identity; retain and reconcile the saved hash",
    );
  record.phase = "broadcast";
  ctx.journal.save();
  return verifyLanded(ctx, record);
}

/** Journaled one-use creation transaction (already reviewed and budget-checked by the caller). */
export async function sendOwnerCreation(
  ctx: SendContext,
  id: string,
  tx: {
    type: "eip1559";
    chainId: number;
    nonce: number;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    value: 0n;
    data: Hex;
  },
): Promise<TxRecord> {
  const prior = ctx.journal.find(id);
  if (prior) return reconcileRecord(ctx, prior);
  const unsignedHash = keccak256(serializeTransaction(tx));
  const account = await createOwnerDeploymentAccount(
    {
      address: ctx.identity.address,
      chainId: ctx.chainId,
      keyId: ctx.identity.keyId,
      region: ctx.identity.region,
    },
    unsignedHash,
    ctx.identity.transport,
  );
  const record: TxRecord = {
    id,
    description: "Deploy the paused MarketRebalancer executor",
    kind: "create",
    to: null,
    data: tx.data,
    value: "0",
    nonce: tx.nonce,
    gas: String(tx.gas),
    maxFeePerGas: String(tx.maxFeePerGas),
    maxPriorityFeePerGas: String(tx.maxPriorityFeePerGas),
    unsignedHash,
    phase: "prepared",
    createdAt: new Date().toISOString(),
  };
  ctx.journal.data.records.push(record);
  ctx.journal.save();
  const raw = await account.signTransaction(tx);
  record.hash = keccak256(raw);
  record.raw = raw;
  record.phase = "signed";
  ctx.journal.save();
  const sent = await ctx.client.sendRawTransaction({
    serializedTransaction: raw,
  });
  if (sent.toLowerCase() !== record.hash.toLowerCase())
    throw new OwnerSafetyError(
      "RPC returned a different transaction identity; retain and reconcile the saved hash",
    );
  record.phase = "broadcast";
  ctx.journal.save();
  return verifyLanded(ctx, record);
}
