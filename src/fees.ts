import {
  parseAbi,
  serializeTransaction,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { ceilDiv } from "./strategy.js";
import { same, type ChainConfig } from "./config.js";
const gasOracle = "0x420000000000000000000000000000000000000F";
const feeAbi = parseAbi([
  "function getL1Fee(bytes transaction) view returns (uint256)",
  "function getOperatorFee(uint256 gasUsed) view returns (uint256)",
]);
/** OP Stack charges fees outside the execution gas limit. Fail closed if the oracle is unavailable
 * or the buffered estimate is larger than the reserve already included in the profit floor. */
export async function assertAdditionalFeeReserve(
  client: PublicClient,
  chain: ChainConfig,
  tx: { to: Address; data: Hex; gas: bigint; gasPrice: bigint; nonce: number },
  reserve: bigint,
  bufferBps: number,
): Promise<void> {
  const actual = await readAdditionalNetworkFees(client, chain, tx);
  if (ceilDiv(actual * BigInt(bufferBps), 10000n) > reserve)
    throw new Error("Additional network fees exceed reserved budget");
}

/** Arbitrum's RPC gas estimate already includes its posting cost. OP fees are read separately. */
export async function readAdditionalNetworkFees(
  client: PublicClient,
  chain: ChainConfig,
  tx: { to: Address; data: Hex; gas: bigint; gasPrice: bigint; nonce: number },
  blockNumber?: bigint,
): Promise<bigint> {
  if (chain.feeModel === "unsupported")
    throw new Error("Network fee model is unsupported");
  if (chain.feeModel === "gas-limit") return 0n;
  const unsigned = serializeTransaction({
    ...tx,
    chainId: chain.chainId,
    type: "legacy",
  });
  const [l1, operator] = await Promise.all([
    client.readContract({
      address: gasOracle,
      abi: feeAbi,
      functionName: "getL1Fee",
      args: [unsigned],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    }),
    client.readContract({
      address: gasOracle,
      abi: feeAbi,
      functionName: "getOperatorFee",
      args: [tx.gas],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    }),
  ]);
  if (l1 < 0n || operator < 0n)
    throw new Error("Invalid additional fee oracle result");
  return l1 + operator;
}

/** Convert native gas units to the configured quote token before requesting a market price.
 * A native stablecoin can have different decimals from its ERC20 representation.
 * Round UP: a sub-micro-USDC network cost must not disappear from the profit floor.
 */
export function nativeCostForQuote(
  chain: ChainConfig,
  configuredToken: Address,
  nativeCost: bigint,
): { token: Address; amount: bigint } {
  if (nativeCost < 0n) throw new Error("Negative native gas cost");
  const equivalent = chain.nativeEquivalent;
  if (!equivalent) return { token: configuredToken, amount: nativeCost };
  if (!chain.nativeCurrency) throw new Error("Native gas decimals are unknown");
  if (!same(configuredToken, equivalent.token))
    throw new Error(
      "Configured gas token does not match native-token representation",
    );
  return {
    token: equivalent.token,
    amount: ceilDiv(
      nativeCost * 10n ** BigInt(equivalent.decimals),
      10n ** BigInt(chain.nativeCurrency.decimals),
    ),
  };
}
