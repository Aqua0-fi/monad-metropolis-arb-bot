import { keccak256, type Hex } from "viem";
export interface RuntimeArtifact {
  object: Hex;
  immutableReferences?: Record<string, { start: number; length: number }[]>;
}
/** Compare compiled code while separately verifying immutable getter values onchain. */
export function normalizeRuntime(code: Hex, artifact: RuntimeArtifact): Hex {
  if (
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) ||
    code.length !== artifact.object.length
  )
    throw new Error(
      "Deployed runtime length or encoding differs from reviewed artifact",
    );
  const bytes = Buffer.from(code.slice(2), "hex");
  for (const positions of Object.values(artifact.immutableReferences ?? {})) {
    for (const p of positions) {
      if (
        !Number.isSafeInteger(p.start) ||
        !Number.isSafeInteger(p.length) ||
        p.start < 0 ||
        p.length <= 0 ||
        p.start + p.length > bytes.length
      )
        throw new Error("Invalid immutable code reference");
      bytes.fill(0, p.start, p.start + p.length);
    }
  }
  return keccak256(bytes);
}
/** Monad charges the full gas limit, so its maximum fee is gas * maxFeePerGas and must stay within budget. */
export function assertCreationBudget(
  tx: {
    type: string;
    chainId: number;
    nonce: number;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    value: bigint;
    data: Hex;
    to?: string;
  },
  maximumFee: bigint,
  chainId: 42161 | 143 = 42161,
) {
  if (
    (chainId !== 42161 && chainId !== 143) ||
    tx.type !== "eip1559" ||
    tx.chainId !== chainId ||
    tx.to ||
    tx.value !== 0n ||
    !/^0x[0-9a-fA-F]+$/.test(tx.data) ||
    tx.data === "0x"
  )
    throw new Error(
      "Only reviewed zero-value contract creation on the selected owner chain (Arbitrum or Monad) is allowed",
    );
  if (
    !Number.isSafeInteger(tx.nonce) ||
    tx.nonce < 0 ||
    tx.gas <= 0n ||
    tx.maxFeePerGas <= 0n ||
    tx.maxPriorityFeePerGas < 0n ||
    tx.maxPriorityFeePerGas > tx.maxFeePerGas ||
    maximumFee <= 0n ||
    tx.gas * tx.maxFeePerGas > maximumFee
  )
    throw new Error(
      "Deployment exceeds the explicit maximum gas budget or has invalid fee fields",
    );
}
