import {
  encodeFunctionData,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { same, type ChainConfig } from "./config.js";
import { executorAbi } from "./abi.js";
import { assertFresh, ceilDiv, type Candidate } from "./strategy.js";
import { readAdditionalNetworkFees } from "./fees.js";
import { createNativeFeeValuer } from "./gas-valuation.js";

/** Owner-requested default safety margin, not an assumed gas price or gas consumption. */
export const DEFAULT_LIVE_FEE_BUFFER_BPS = 10500;
const MAX_FEE_REFINEMENT_PASSES = 4;
/** A priced candidate rejection before signing, not a failed transaction or RPC uncertainty. */
export class FeeProfitRefusal extends Error {
  constructor(
    readonly conservativeGross: bigint,
    readonly tokenCost: bigint,
    readonly requiredGross: bigint,
  ) {
    super(
      "Trade profit cannot cover measured fees and the required net profit",
    );
    this.name = "FeeProfitRefusal";
  }
}

export interface LiveFeePolicy {
  executor: Address;
  operator: Address;
  maxGasUnits: bigint;
  maxFeePerGas: bigint;
  l1FeeReserveWei: bigint;
  wrappedNative: Address;
  liveFeeBufferBps?: number | undefined;
}
export interface LiveFeeEstimate {
  observedAt: number;
  blockNumber: bigint;
  blockHash: Hex;
  gas: bigint;
  gasPrice: bigint;
  additionalNative: bigint;
  nativeCost: bigint;
  tokenCost: bigint;
  calldataHash: Hex;
  data: Hex;
  conversionFee: number | null;
  conversionPool: Address | null;
  conversionQuoter: Address | null;
}

/** Read-only, whole-transaction economics. No key, signing, allowance change or state override.
 * A paused/unfunded/unauthorized route has no executable fee estimate, never a made-up zero fee.
 * Profit-floor changes alter calldata, so estimate the exact final call again before trusting it.
 */
export async function finalizeCandidateFees(
  client: PublicClient,
  chain: ChainConfig,
  policy: LiveFeePolicy,
  candidate: Candidate,
  block: { number: bigint; hash: Hex },
  nonce: number,
  minimumOnchainProfit: bigint,
  onchainGasPriceCap: bigint,
): Promise<LiveFeeEstimate> {
  delete candidate.feeEstimate;
  const observedAt = Date.now();
  if ((await client.getChainId()) !== chain.chainId)
    throw new Error("Fee RPC chain mismatch");
  const buffer = policy.liveFeeBufferBps ?? DEFAULT_LIVE_FEE_BUFFER_BPS;
  if (!Number.isInteger(buffer) || buffer < 10000 || buffer > 20000)
    throw new Error("Invalid live fee safety policy");
  const observedGasPrice = await client.getGasPrice();
  if (observedGasPrice <= 0n) throw new Error("Live gas price is unavailable");
  const gasPrice = ceilDiv(observedGasPrice * BigInt(buffer), 10000n);
  if (gasPrice > policy.maxFeePerGas || gasPrice > onchainGasPriceCap)
    throw new Error("Live gas price cap exceeded");
  const minimumNetProfit =
    candidate.minimumNetProfit ?? candidate.trade.minProfit;
  if (minimumNetProfit <= 0n || minimumOnchainProfit <= 0n)
    throw new Error(
      "A positive operator and onchain profit policy is required",
    );
  const initialFloor =
    minimumNetProfit > minimumOnchainProfit
      ? minimumNetProfit
      : minimumOnchainProfit;
  const trade = { ...candidate.trade, minProfit: initialFloor };
  const conservativeGross = trade.second.minOut - trade.first.amountIn;
  const valueNative = createNativeFeeValuer(
    client,
    chain,
    policy.wrappedNative,
    trade.first.tokenIn,
    block,
    !same(trade.first.tokenIn, policy.wrappedNative) &&
      same(trade.first.tokenOut, policy.wrappedNative)
      ? trade.first.venue === 1
        ? trade.first.target
        : trade.second.venue === 1
          ? trade.second.target
          : undefined
      : undefined,
  );
  for (let pass = 0; pass < MAX_FEE_REFINEMENT_PASSES; pass++) {
    const data = encodeFunctionData({
      abi: executorAbi,
      functionName: "execute",
      args: [trade],
    });
    const gas = await client.estimateGas({
      account: policy.operator,
      to: policy.executor,
      data,
      gasPrice,
      nonce,
      blockNumber: block.number,
    });
    if (gas <= 0n) throw new Error("RPC returned an invalid gas estimate");
    if (gas > policy.maxGasUnits)
      throw new Error("Estimated gas unit cap exceeded");
    const rawAdditional = await readAdditionalNetworkFees(
      client,
      chain,
      { to: policy.executor, data, gas, gasPrice, nonce },
      block.number,
    );
    const additionalNative = ceilDiv(rawAdditional * BigInt(buffer), 10000n);
    if (additionalNative > policy.l1FeeReserveWei)
      throw new Error("Actual additional fees exceed the configured ceiling");
    const nativeCost = gas * gasPrice + additionalNative;
    const converted = await valueNative(nativeCost);
    const required = converted.tokenCost + minimumNetProfit;
    const floor = required > initialFloor ? required : initialFloor;
    if (conservativeGross < floor)
      throw new FeeProfitRefusal(conservativeGross, converted.tokenCost, floor);
    if (floor > trade.minProfit) {
      trade.minProfit = floor;
      continue;
    }
    const simulated = await client.simulateContract({
      address: policy.executor,
      abi: executorAbi,
      functionName: "execute",
      args: [trade],
      account: policy.operator,
      gasPrice,
      gas,
      blockNumber: block.number,
    });
    if (
      typeof simulated.result !== "bigint" ||
      simulated.result < trade.minProfit
    )
      throw new Error(
        "Full transaction profit simulation did not satisfy the fee floor",
      );
    if (
      (await client.getBlock({ blockNumber: block.number })).hash !== block.hash
    )
      throw new Error("Fee simulation block reorganized");
    const estimate: LiveFeeEstimate = {
      observedAt,
      blockNumber: block.number,
      blockHash: block.hash,
      gas,
      gasPrice,
      additionalNative,
      nativeCost,
      tokenCost: converted.tokenCost,
      calldataHash: keccak256(data),
      data,
      conversionFee: converted.conversionFee,
      conversionPool: converted.conversionPool,
      conversionQuoter: converted.conversionQuoter,
    };
    candidate.trade = trade;
    candidate.minimumNetProfit = minimumNetProfit;
    candidate.netProfit = conservativeGross - estimate.tokenCost;
    candidate.quotedProfit = simulated.result;
    candidate.feeEstimate = estimate;
    return estimate;
  }
  throw new Error(
    "Transaction fee refinement did not converge; no execution estimate accepted",
  );
}

/** The exact full-call proof replaces provisional quote freshness, not its calldata or risk limits. */
export function assertFeeEstimateFresh(
  estimate: LiveFeeEstimate,
  candidate: Candidate,
  head: { number: bigint; hash: Hex },
  now: number,
  maxAgeMs: number,
  maxBlockLag: number,
): void {
  assertFresh(
    { quotedAt: estimate.observedAt, blockNumber: estimate.blockNumber },
    head.number,
    now,
    maxAgeMs,
    maxBlockLag,
  );
  if (head.number === estimate.blockNumber && head.hash !== estimate.blockHash)
    throw new Error("Execution simulation block reorganized");
  const data = encodeFunctionData({
    abi: executorAbi,
    functionName: "execute",
    args: [candidate.trade],
  });
  if (keccak256(data) !== estimate.calldataHash || estimate.data !== data)
    throw new Error("Trade changed after its full transaction fee simulation");
}
