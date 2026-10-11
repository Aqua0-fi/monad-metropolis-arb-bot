import { executorAbi } from "./abi.js";
import { readAwsSessionFile } from "./aws-session-file.js";
import { createPublicKey, randomBytes } from "node:crypto";
import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
} from "@aws-sdk/client-kms";
import {
  getAddress,
  decodeFunctionData,
  hashMessage,
  keccak256,
  recoverAddress,
  serializeSignature,
  serializeTransaction,
  toBytes,
  toHex,
  type Address,
  type Hex,
  type LocalAccount,
  type Signature,
} from "viem";
import { toAccount } from "viem/accounts";

const CURVE_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const KEY_ARN =
  /^arn:aws:kms:([a-z0-9-]+):[0-9]{12}:key\/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$/;
export interface KmsAccountConfig {
  keyId: string;
  region: string;
  address: Address;
  chainId: number;
  target?: Address;
}
export interface KmsTransport {
  publicKey(keyId: string): Promise<{
    keyId: string;
    keySpec: string;
    keyUsage: string;
    der: Uint8Array;
  }>;
  signDigest(
    keyId: string,
    digest: Uint8Array,
  ): Promise<{ keyId: string; algorithm: string; der: Uint8Array }>;
}

/** This key produces at most a 72-byte DER signature; long-form or non-canonical encodings are refused. */
export function parseDerSignature(input: Uint8Array): { r: bigint; s: bigint } {
  if (
    input.length < 8 ||
    input.length > 72 ||
    input[0] !== 0x30 ||
    input[1] !== input.length - 2
  )
    throw new Error("Invalid KMS DER sequence");
  let offset = 2;
  const integer = (): bigint => {
    if (input[offset++] !== 2) throw new Error("Invalid KMS DER integer");
    const length = input[offset++];
    if (!length || length > 33 || offset + length > input.length)
      throw new Error("Invalid KMS DER integer length");
    const bytes = input.subarray(offset, offset + length);
    offset += length;
    if (bytes[0]! & 128 || (bytes[0] === 0 && length > 1 && !(bytes[1]! & 128)))
      throw new Error("Non-canonical KMS DER integer");
    const value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
    if (value <= 0n || value >= CURVE_ORDER)
      throw new Error("KMS signature scalar outside secp256k1");
    return value;
  };
  const r = integer(),
    s = integer();
  if (offset !== input.length) throw new Error("Trailing KMS signature data");
  return { r, s };
}
function validateConfig(config: KmsAccountConfig): void {
  const match = KEY_ARN.exec(config.keyId);
  if (!match || match[1] !== config.region)
    throw new Error(
      "KMS key ARN and region must match; aliases are not signing identities",
    );
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0)
    throw new Error("Invalid signing chain");
  getAddress(config.address);
}
export function awsKmsTransport(region: string): KmsTransport {
  const credentialFile = process.env.REBALANCER_AWS_CREDENTIALS_FILE;
  const client = new KMSClient({
    region,
    ...(credentialFile
      ? { credentials: async () => readAwsSessionFile(credentialFile) }
      : {}),
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 5000, socketTimeout: 10000 },
  });
  return {
    async publicKey(keyId) {
      let result;
      try {
        result = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
      } catch {
        throw new Error(
          "KMS public-key read failed; check the dedicated credential and region",
        );
      }
      if (!result.KeyId || !result.PublicKey)
        throw new Error("KMS public-key response is incomplete");
      return {
        keyId: result.KeyId,
        keySpec: result.KeySpec ?? "",
        keyUsage: result.KeyUsage ?? "",
        der: result.PublicKey,
      };
    },
    async signDigest(keyId, digest) {
      let result;
      try {
        result = await client.send(
          new SignCommand({
            KeyId: keyId,
            Message: digest,
            MessageType: "DIGEST",
            SigningAlgorithm: "ECDSA_SHA_256",
          }),
        );
      } catch {
        throw new Error(
          "KMS digest signing failed; no local-key fallback is permitted",
        );
      }
      if (!result.KeyId || !result.Signature)
        throw new Error("KMS signature response is incomplete");
      return {
        keyId: result.KeyId,
        algorithm: result.SigningAlgorithm ?? "",
        der: result.Signature,
      };
    },
  };
}
async function verifiedAddress(
  config: KmsAccountConfig,
  transport: KmsTransport,
): Promise<Address> {
  validateConfig(config);
  const publicKey = await transport.publicKey(config.keyId);
  if (publicKey.keyId !== config.keyId)
    throw new Error("KMS key identity changed");
  if (
    publicKey.keySpec !== "ECC_SECG_P256K1" ||
    publicKey.keyUsage !== "SIGN_VERIFY"
  )
    throw new Error("Wrong KMS key type or usage");
  const jwk = createPublicKey({
    key: Buffer.from(publicKey.der),
    type: "spki",
    format: "der",
  }).export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "secp256k1" || !jwk.x || !jwk.y)
    throw new Error("Invalid KMS public key curve");
  const x = Buffer.from(jwk.x, "base64url"),
    y = Buffer.from(jwk.y, "base64url");
  if (x.length !== 32 || y.length !== 32)
    throw new Error("Invalid KMS public point length");
  const address = getAddress(
    `0x${keccak256(Buffer.concat([x, y])).slice(-40)}`,
  );
  if (address.toLowerCase() !== config.address.toLowerCase())
    throw new Error("KMS operator address does not match configuration");
  return address;
}
async function sign(
  config: KmsAccountConfig,
  transport: KmsTransport,
  address: Address,
  digest: Hex,
): Promise<Signature> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest))
    throw new Error("KMS requires a 32-byte digest");
  const response = await transport.signDigest(config.keyId, toBytes(digest));
  if (response.keyId !== config.keyId)
    throw new Error("KMS signing key identity changed");
  if (response.algorithm !== "ECDSA_SHA_256")
    throw new Error("Wrong KMS signing algorithm");
  const parsed = parseDerSignature(response.der);
  const r = toHex(parsed.r, { size: 32 });
  const s = toHex(
    parsed.s > CURVE_ORDER / 2n ? CURVE_ORDER - parsed.s : parsed.s,
    { size: 32 },
  );
  for (const yParity of [0, 1] as const) {
    const signature = { r, s, v: BigInt(27 + yParity), yParity };
    try {
      if (
        (await recoverAddress({ hash: digest, signature })).toLowerCase() ===
        address.toLowerCase()
      )
        return signature;
    } catch {
      /* Try the other recovery bit; never return an unverified signature. */
    }
  }
  throw new Error("KMS signature does not recover the configured operator");
}

/** A transaction-only account. It grants no JIT signing, admin action, or typed-message capability. */
export async function createKmsAccount(
  config: KmsAccountConfig,
  transport: KmsTransport = awsKmsTransport(config.region),
): Promise<LocalAccount> {
  const address = await verifiedAddress(config, transport);
  return toAccount({
    address,
    async signMessage() {
      throw new Error(
        "Arbitrary message signing is not supported by the worker account",
      );
    },
    async signTypedData() {
      throw new Error(
        "Typed authorization signing is not supported by the worker account",
      );
    },
    async signTransaction(transaction, options) {
      if (transaction.chainId !== config.chainId)
        throw new Error(
          "Transaction signing chain does not match configured chain",
        );
      if (transaction.type !== "legacy" && transaction.type !== "eip1559")
        throw new Error("Unsupported worker transaction type");
      if (!transaction.to || (transaction.value ?? 0n) !== 0n)
        throw new Error(
          "Worker cannot deploy contracts or transfer native inventory",
        );
      if (
        config.target &&
        transaction.to.toLowerCase() !== config.target.toLowerCase()
      )
        throw new Error(
          "Worker transaction target is not the configured executor",
        );
      if (config.target) {
        let method: string | undefined;
        try {
          method = decodeFunctionData({
            abi: executorAbi,
            data: transaction.data ?? "0x",
          }).functionName;
        } catch {
          throw new Error("Worker may only sign complete execute calldata");
        }
        if (method !== "execute")
          throw new Error("Worker cannot sign owner setup or withdrawal calls");
      }
      if (options?.serializer && options.serializer !== serializeTransaction)
        throw new Error("Custom transaction serializers are not supported");
      const signature = await sign(
        config,
        transport,
        address,
        keccak256(serializeTransaction(transaction)),
      );
      return serializeTransaction(transaction, signature);
    },
  });
}

/** Owner-run chains. Arbitrum keeps its reviewed script-level caps unchanged; Monad charges gas on the
 * full gas limit, so its owner signers also enforce explicit gas-limit and maximum-fee ceilings here.
 * These are last-resort signer bounds; the owner scripts apply tighter policy budgets first.
 */
export const OWNER_SIGNING_CHAINS: Readonly<
  Record<
    number,
    {
      name: string;
      callValueAllowed: boolean;
      maxCreationGas?: bigint;
      maxCreationFeeWei?: bigint;
      maxCallGas?: bigint;
      maxCallFeeWei?: bigint;
    }
  >
> = {
  42161: { name: "Arbitrum", callValueAllowed: true },
  143: {
    name: "Monad",
    // Never send MON to a contract from an owner call; creation and calls are zero-value only.
    callValueAllowed: false,
    maxCreationGas: 6_000_000n,
    maxCreationFeeWei: 2_000_000_000_000_000_000n, // 2 MON
    maxCallGas: 500_000n,
    maxCallFeeWei: 500_000_000_000_000_000n, // 0.5 MON
  },
};
function ownerChain(chainId: number) {
  return Object.hasOwn(OWNER_SIGNING_CHAINS, chainId)
    ? OWNER_SIGNING_CHAINS[chainId]
    : undefined;
}

/** Owner-invoked CLI only: one exact reviewed Arbitrum or Monad creation, never a worker permission.
 * The ordinary createKmsAccount still refuses deployments and native transfers.
 */
export async function createOwnerDeploymentAccount(
  config: KmsAccountConfig,
  reviewedUnsignedHash: Hex,
  transport: KmsTransport = awsKmsTransport(config.region),
): Promise<LocalAccount> {
  const budget = ownerChain(config.chainId);
  if (!budget || config.target)
    throw new Error(
      "Owner deployment signing is restricted to reviewed Arbitrum or Monad creation",
    );
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(reviewedUnsignedHash) ||
    BigInt(reviewedUnsignedHash) === 0n
  )
    throw new Error("Missing reviewed deployment transaction identity");
  const address = await verifiedAddress(config, transport);
  let used = false;
  return toAccount({
    address,
    async signMessage() {
      throw new Error("Owner deployment signer cannot sign messages");
    },
    async signTypedData() {
      throw new Error("Owner deployment signer cannot sign typed data");
    },
    async signTransaction(transaction, options) {
      if (transaction.chainId !== config.chainId)
        throw new Error(
          "Transaction chain differs from the reviewed owner chain (Arbitrum or Monad only)",
        );
      if (
        transaction.type !== "eip1559" ||
        transaction.to ||
        (transaction.value ?? 0n) !== 0n ||
        !transaction.data ||
        transaction.data === "0x"
      )
        throw new Error("Only zero-value contract creation is permitted");
      if (
        budget.maxCreationGas !== undefined &&
        (transaction.gas === undefined ||
          transaction.maxFeePerGas === undefined ||
          transaction.gas > budget.maxCreationGas ||
          transaction.gas * transaction.maxFeePerGas >
            budget.maxCreationFeeWei!)
      )
        throw new Error(
          `${budget.name} creation exceeds the signer gas-limit or maximum-fee budget`,
        );
      if (options?.serializer && options.serializer !== serializeTransaction)
        throw new Error("Custom transaction serializers are not supported");
      const digest = keccak256(serializeTransaction(transaction));
      if (digest.toLowerCase() !== reviewedUnsignedHash.toLowerCase())
        throw new Error(
          "Transaction differs from the exact reviewed deployment",
        );
      if (used)
        throw new Error("This deployment signing intent was already used");
      used = true;
      return serializeTransaction(
        transaction,
        await sign(config, transport, address, digest),
      );
    },
  });
}

/** One owner-approved call. Not used by the worker and not a reusable account permission. */
export async function createOwnerCallAccount(
  config: KmsAccountConfig,
  reviewedUnsignedHash: Hex,
  transport: KmsTransport = awsKmsTransport(config.region),
): Promise<LocalAccount> {
  const budget = ownerChain(config.chainId);
  if (
    !budget ||
    !config.target ||
    BigInt(config.target) === 0n ||
    !/^0x[0-9a-fA-F]{64}$/.test(reviewedUnsignedHash) ||
    BigInt(reviewedUnsignedHash) === 0n
  )
    throw new Error(
      "An exact reviewed Arbitrum or Monad owner call is required",
    );
  const address = await verifiedAddress(config, transport);
  let used = false;
  return toAccount({
    address,
    async signMessage() {
      throw new Error("Owner call signer cannot sign messages");
    },
    async signTypedData() {
      throw new Error("Owner call signer cannot sign typed data");
    },
    async signTransaction(transaction, options) {
      if (
        transaction.chainId !== config.chainId ||
        transaction.type !== "legacy" ||
        !transaction.to ||
        getAddress(transaction.to) !== getAddress(config.target!) ||
        !transaction.data ||
        transaction.data === "0x"
      )
        throw new Error("Transaction is not the reviewed owner contract call");
      if (!budget.callValueAllowed && (transaction.value ?? 0n) !== 0n)
        throw new Error(
          `${budget.name} owner calls never transfer native value`,
        );
      if (
        budget.maxCallGas !== undefined &&
        (transaction.gas === undefined ||
          transaction.gasPrice === undefined ||
          transaction.gas > budget.maxCallGas ||
          transaction.gas * transaction.gasPrice > budget.maxCallFeeWei!)
      )
        throw new Error(
          `${budget.name} owner call exceeds the signer gas-limit or maximum-fee budget`,
        );
      if (options?.serializer && options.serializer !== serializeTransaction)
        throw new Error("Custom transaction serializers are unsupported");
      const digest = keccak256(serializeTransaction(transaction));
      if (digest.toLowerCase() !== reviewedUnsignedHash.toLowerCase())
        throw new Error(
          "Owner transaction differs from the exact reviewed bytes",
        );
      if (used) throw new Error("This owner call intent was already used");
      used = true;
      return serializeTransaction(
        transaction,
        await sign(config, transport, address, digest),
      );
    },
  });
}

/** Non-transaction, domain-separated readiness proof. Never signs an approval or a reusable trade. */
export async function verifyKmsReadiness(
  config: KmsAccountConfig,
  transport: KmsTransport = awsKmsTransport(config.region),
) {
  const address = await verifiedAddress(config, transport);
  const message = `market-rebalancer-service KMS readiness only; not a transaction or authorization; ${new Date().toISOString()}; ${randomBytes(24).toString("hex")}`;
  const digest = hashMessage(message);
  const signature = serializeSignature(
    await sign(config, transport, address, digest),
  );
  return {
    purpose: "kms-readiness-only",
    address,
    chainId: config.chainId,
    keyId: config.keyId,
    message,
    digest,
    signature,
    transactionsSent: 0,
  };
}
