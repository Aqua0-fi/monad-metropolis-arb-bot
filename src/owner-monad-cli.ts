import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { RuntimeArtifact } from "./owner-deployment.js";
import {
  monadPolicySchema,
  MONAD_CHAIN_ID,
  type MonadPolicy,
} from "./owner-monad.js";
import {
  OwnerSafetyError,
  assertFreeMonadRpc,
  readPrivateJson,
  DEFAULT_MONAD_RPC,
  type JournalFile,
  type OwnerSignerMode,
} from "./owner-tx.js";

export const REPO_ROOT = resolve(import.meta.dirname, "..");
export const DEFAULT_STATE_DIR = join(REPO_ROOT, "runtime/monad-pilot");
export const DEPLOY_SCOPE = "monad-executor-deployment";

export interface ExecutorArtifact {
  abi: Abi;
  bytecode: { object: Hex };
  deployedBytecode: RuntimeArtifact;
  metadata: string | { compiler: { version: string } };
}
export function loadPolicy(
  path = join(REPO_ROOT, "config/monad-owner-pilot.json"),
): MonadPolicy {
  return monadPolicySchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
/** The build must equal the reviewed Monad manifest; never auto-rebuild for sending. */
export function loadReviewedArtifact(): {
  artifact: ExecutorArtifact;
  creationCodeHash: Hex;
} {
  const artifact = JSON.parse(
    readFileSync(
      join(REPO_ROOT, "out/MarketRebalancer.sol/MarketRebalancer.json"),
      "utf8",
    ),
  ) as ExecutorArtifact;
  const manifest = JSON.parse(
    readFileSync(
      join(REPO_ROOT, "config/owner-deployment-artifact-monad.json"),
      "utf8",
    ),
  );
  const metadata =
    typeof artifact.metadata === "string"
      ? JSON.parse(artifact.metadata)
      : artifact.metadata;
  if (
    manifest.chainId !== MONAD_CHAIN_ID ||
    metadata.compiler.version !== manifest.compiler ||
    keccak256(artifact.bytecode.object) !== manifest.creationCodeHash
  )
    throw new OwnerSafetyError(
      "Build artifact differs from the reviewed Monad executor (config/owner-deployment-artifact-monad.json). Run `forge build`; if it still differs, stop and review.",
    );
  return { artifact, creationCodeHash: manifest.creationCodeHash };
}
export function monadClient(rpcUrl: string): PublicClient {
  assertFreeMonadRpc(rpcUrl);
  return createPublicClient({
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }),
    cacheTime: 0,
  }) as PublicClient;
}
export function rpcFrom(value: string | undefined) {
  return assertFreeMonadRpc(value ?? DEFAULT_MONAD_RPC);
}
export function signerFrom(value: string | undefined): OwnerSignerMode {
  if (value === undefined || value === "kms") return "kms";
  if (value === "anvil-test") return "anvil-test";
  throw new OwnerSafetyError("--signer must be kms or anvil-test");
}
export function stateDirFrom(value: string | undefined) {
  return resolve(value ?? DEFAULT_STATE_DIR);
}

/** Executor address from the verified deployment journal (or an explicit flag that is then verified onchain). */
export function deployedExecutor(stateDir: string, explicit?: string): Address {
  if (explicit) return getAddress(explicit);
  const path = join(stateDir, "deployment.json");
  if (!existsSync(path))
    throw new OwnerSafetyError(
      `No verified Monad deployment journal at ${path}; deploy first or pass --executor`,
    );
  const j = readPrivateJson<JournalFile>(path);
  const record = j.records.find((r) => r.id === "deploy");
  const executor = j.meta.executor as string | undefined;
  if (
    j.chainId !== MONAD_CHAIN_ID ||
    j.scope !== DEPLOY_SCOPE ||
    !record ||
    record.phase !== "confirmed" ||
    !executor ||
    j.meta.verified !== true ||
    getContractAddress({
      from: getAddress(j.owner),
      nonce: BigInt(record.nonce),
    }) !== getAddress(executor)
  )
    throw new OwnerSafetyError(
      "The Monad deployment journal is not a verified paused deployment; run owner-deploy-monad --status",
    );
  return getAddress(executor);
}

export const KMS_IDENTITY_FILE =
  "/Users/rithikkumars/CodingStuff/Aqua0/secrets/market-rebalancer.kms.json";
/**
 * Non-secret KMS identity (region + key ARN) for the worker config, from the owner's KMS record.
 * Only those two fields are read; values are never printed. The key must belong to the policy owner.
 */
export function kmsIdentity(
  owner: Address,
  path = KMS_IDENTITY_FILE,
): { region: string; keyId: string } | null {
  if (!existsSync(path)) return null;
  const record = readPrivateJson<Record<string, unknown>>(path, 65_536);
  const region = record.region;
  const keyId = record.kmsKeyArn;
  if (
    typeof region !== "string" ||
    typeof keyId !== "string" ||
    !/^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key\/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$/.test(
      keyId,
    ) ||
    keyId.split(":")[3] !== region ||
    typeof record.operatorAddress !== "string" ||
    getAddress(record.operatorAddress) !== getAddress(owner)
  )
    throw new OwnerSafetyError(
      `KMS identity record ${path} is incomplete or belongs to another wallet`,
    );
  return { region, keyId };
}

/** Interactive typed confirmation. Refuses when stdin/stdout is not a terminal. */
export async function typedConfirmation(
  prompt: string,
  expected: string,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new OwnerSafetyError(
      "This action requires the owner at an interactive terminal",
    );
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await terminal.question(
      `${prompt} Type ${expected} to proceed: `,
    );
    return answer === expected;
  } finally {
    terminal.close();
  }
}
