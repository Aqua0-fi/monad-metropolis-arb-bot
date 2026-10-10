import { z } from "zod";
import { encodeFunctionData, getAddress, parseAbi, type Address } from "viem";
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => getAddress(value));
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v.toLowerCase() as `0x${string}`);
const amount = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(78)
  .transform(BigInt)
  .refine((v) => v < 1n << 256n);
const planSchema = z.object({
  version: z.literal(1),
  scope: z.literal("hackathon-only"),
  state: z.literal("ready_for_owner_review"),
  network: z.enum(["mainnet", "fork"]),
  chainId: z.literal(42161),
  token: address,
  executor: address,
  netProfit: amount,
  returnAmount: amount,
  evidenceHash: hash,
  payoutStatus: z.literal("not_submitted"),
  executionHashes: z.array(hash).min(1).max(20),
  allocations: z
    .array(z.object({ lp: address, amount }))
    .min(1)
    .max(100),
});
export const profitReturnAbi = parseAbi([
  "function distribute(bytes32[],bytes32,uint256,address[],uint256[])",
  "function owner() view returns(address)",
  "function executor() view returns(address)",
  "function token() view returns(address)",
  "function processed(bytes32) view returns(bool)",
]);
const tokenAbi = parseAbi(["function approve(address,uint256) returns(bool)"]);
/** Offline calldata preparation only; no account, signature, allowance or transfer is created. */
export function buildUnsignedProfitReturn(
  input: unknown,
  ownerInput: Address,
  distributorInput: Address,
) {
  const p = planSchema.parse(input),
    owner = getAddress(ownerInput),
    distributor = getAddress(distributorInput);
  if (
    BigInt(owner) === 0n ||
    BigInt(distributor) === 0n ||
    distributor === owner ||
    BigInt(p.evidenceHash) === 0n
  )
    throw new Error("Invalid owner or distributor");
  if (
    p.netProfit <= 0n ||
    p.returnAmount !== (p.netProfit * 9n) / 10n ||
    p.returnAmount === 0n
  )
    throw new Error("Not an exact 90% return of positive net profit");
  if (
    new Set(p.executionHashes).size !== p.executionHashes.length ||
    p.executionHashes.some((id) => BigInt(id) === 0n)
  )
    throw new Error("Duplicate or zero execution hash");
  let previous = 0n,
    total = 0n;
  for (const row of p.allocations) {
    if (
      BigInt(row.lp) <= previous ||
      row.lp === owner ||
      row.lp === distributor ||
      row.amount === 0n
    )
      throw new Error("Invalid or duplicate recipient");
    previous = BigInt(row.lp);
    total += row.amount;
  }
  if (total !== p.returnAmount)
    throw new Error("Recipient amounts do not sum to the return pool");
  const approve = encodeFunctionData({
    abi: tokenAbi,
    functionName: "approve",
    args: [distributor, total],
  });
  const distribute = encodeFunctionData({
    abi: profitReturnAbi,
    functionName: "distribute",
    args: [
      p.executionHashes,
      p.evidenceHash,
      p.netProfit,
      p.allocations.map((a) => a.lp),
      p.allocations.map((a) => a.amount),
    ],
  });
  return {
    version: 1,
    network: p.network,
    chainId: 42161,
    owner,
    executor: p.executor,
    token: p.token,
    distributor,
    evidenceHash: p.evidenceHash,
    returnedAmount: total.toString(),
    broadcast: false,
    signaturesProduced: 0,
    payoutStatus: "not_submitted",
    transactions: [
      { from: owner, to: p.token, data: approve, value: "0" },
      { from: owner, to: distributor, data: distribute, value: "0" },
    ],
    requiredBeforeSigning: [
      "Verify distributor deployed code against the reviewed artifact, owner, executor and token bindings.",
      "Verify every included execution hash remains canonical and processed(hash) is false on this distributor.",
      "Recheck the complete batch for new losses or unknown costs, and review payout gas in addition to the displayed trading fees.",
      "Use only realized surplus withdrawn by the owner after retaining operating capital. Never approve the LP vault or unrelated treasury.",
      "Verify the owner's token allowance is zero before the exact approval; clear any old allowance separately if needed.",
    ],
  };
}
