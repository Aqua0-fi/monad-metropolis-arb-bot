import {
  encodeFunctionData,
  formatEther,
  getAddress,
  parseAbi,
  parseEther,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { OwnerSafetyError } from "./owner-tx.js";

/**
 * Arbitrum ETH -> Monad MON through Relay (https://docs.relay.link): a public quote API with no key that
 * returns one native deposit transaction. Relay's solver pays out on Monad; the deposit is refundable to
 * the same wallet. Every field that decides where value goes is checked here before anything is signed.
 */
export const RELAY_API = "https://api.relay.link";
/** Relay protocol v2 depository on Arbitrum, read from GET /chains (protocol.v2.depository) on 2026-10-12. */
export const RELAY_ARBITRUM_DEPOSITORY = getAddress(
  "0x4cd00e387622c35bddb9b4c962c136462338bc31",
);
export const BRIDGE_SOURCE_CHAIN = 42161;
export const BRIDGE_DESTINATION_CHAIN = 143;
export const BRIDGE_MAX_WEI = parseEther("0.0015");
/** Minimum USD value of the guaranteed output relative to the input (fees + slippage <= 10%). */
export const BRIDGE_MIN_OUT_RATIO_BPS = 9000n;
export const relayDepositAbi = parseAbi([
  "function depositNative(address depositor, bytes32 id) payable",
]);

export function bridgeAmount(text: string): bigint {
  if (!/^0\.[0-9]{1,18}$/.test(text))
    throw new OwnerSafetyError("--amount-eth must look like 0.001");
  const wei = parseEther(text);
  if (wei <= 0n || wei > BRIDGE_MAX_WEI)
    throw new OwnerSafetyError(
      `--amount-eth must be > 0 and at most ${formatEther(BRIDGE_MAX_WEI)} ETH`,
    );
  return wei;
}
export function relayQuoteRequest(owner: Address, amountWei: bigint) {
  return {
    user: owner,
    recipient: owner,
    originChainId: BRIDGE_SOURCE_CHAIN,
    destinationChainId: BRIDGE_DESTINATION_CHAIN,
    originCurrency: zeroAddress,
    destinationCurrency: zeroAddress,
    amount: amountWei.toString(),
    tradeType: "EXACT_INPUT",
  };
}

export interface ValidatedBridge {
  requestId: Hex;
  orderId: Hex;
  chainId: 42161;
  destinationChainId: 143;
  from: Address;
  recipient: Address;
  to: Address;
  data: Hex;
  value: bigint;
  expectedOutWei: bigint;
  minimumOutWei: bigint;
  inputUsd: number;
  minimumOutUsd: number;
  fees: { name: string; amount: string; symbol: string; usd: string }[];
  deadline: number;
  timeEstimateSeconds: number;
  statusPath: string;
}
type J = Record<string, any>;
const sameAddr = (a: unknown, b: string) =>
  typeof a === "string" &&
  /^0x[0-9a-fA-F]{40}$/.test(a) &&
  a.toLowerCase() === b.toLowerCase();
const uintStr = (v: unknown, label: string) => {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v))
    throw new OwnerSafetyError(`Relay quote: invalid ${label}`);
  return BigInt(v);
};

/** Refuse any quote that is not exactly: one native deposit from the owner, paid out as MON to the owner on 143. */
export function validateRelayQuote(
  quote: unknown,
  expected: { owner: Address; amountWei: bigint; nowSeconds: number },
): ValidatedBridge {
  const owner = getAddress(expected.owner);
  const fail = (why: string): never => {
    throw new OwnerSafetyError(`Relay quote refused: ${why}`);
  };
  if (expected.amountWei <= 0n || expected.amountWei > BRIDGE_MAX_WEI)
    fail("amount outside the bridge cap");
  const q = quote as J;
  if (!q || typeof q !== "object") fail("not an object");
  if (!/^0x[0-9a-fA-F]{64}$/.test(q.requestId ?? ""))
    fail("missing request id");
  if (!Array.isArray(q.steps) || q.steps.length !== 1)
    fail("expected exactly one step (no approvals or extra calls)");
  const step = q.steps[0] as J;
  if (step.id !== "deposit" || step.kind !== "transaction")
    fail("the step is not a native deposit transaction");
  if (!Array.isArray(step.items) || step.items.length !== 1)
    fail("expected exactly one deposit transaction");
  const tx = (step.items[0] as J).data as J;
  if (!tx || Number(tx.chainId) !== BRIDGE_SOURCE_CHAIN)
    fail("deposit is not on Arbitrum (42161)");
  if (!sameAddr(tx.from, owner)) fail("deposit sender is not the KMS wallet");
  if (!sameAddr(tx.to, RELAY_ARBITRUM_DEPOSITORY))
    fail("deposit target is not the pinned Relay depository");
  if (uintStr(tx.value, "deposit value") !== expected.amountWei)
    fail("deposit value differs from the requested amount");
  const v2 = q.protocol?.v2 as J;
  if (!v2 || !/^0x[0-9a-fA-F]{64}$/.test(v2.orderId ?? ""))
    fail("missing protocol order id");
  const orderId = v2.orderId as Hex;
  const data = encodeFunctionData({
    abi: relayDepositAbi,
    functionName: "depositNative",
    args: [owner, orderId],
  });
  if (
    typeof tx.data !== "string" ||
    tx.data.toLowerCase() !== data.toLowerCase()
  )
    fail("deposit calldata is not depositNative(KMS wallet, orderId)");
  const pay = v2.paymentDetails as J;
  if (
    !pay ||
    pay.chainId !== "arbitrum" ||
    !sameAddr(pay.depository, RELAY_ARBITRUM_DEPOSITORY) ||
    !sameAddr(pay.currency, zeroAddress) ||
    uintStr(pay.amount, "payment amount") !== expected.amountWei
  )
    fail("payment details differ from the deposit");
  const order = v2.orderData as J;
  const output = order?.output as J;
  if (!output || output.chainId !== "monad")
    fail("order output is not on Monad");
  if (!Array.isArray(output.payments) || output.payments.length !== 1)
    fail("order must pay exactly one recipient");
  if (
    Array.isArray(output.calls)
      ? output.calls.length !== 0
      : output.calls !== undefined
  )
    fail("order contains destination calls");
  const payment = output.payments[0] as J;
  if (!sameAddr(payment.recipient, owner))
    fail("destination recipient is not the KMS wallet");
  if (!sameAddr(payment.currency, zeroAddress))
    fail("destination currency is not native MON");
  const minimumOutWei = uintStr(payment.minimumAmount, "minimum output");
  const expectedOutWei = uintStr(payment.expectedAmount, "expected output");
  if (minimumOutWei === 0n || expectedOutWei < minimumOutWei)
    fail("output amounts are inconsistent");
  const deadline = Number(output.deadline);
  if (!Number.isSafeInteger(deadline) || deadline < expected.nowSeconds + 120)
    fail("order expires too soon");
  for (const input of (order.inputs ?? []) as J[])
    for (const refund of (input.refunds ?? []) as J[])
      if (!sameAddr(refund.recipient, owner))
        fail("a refund goes to a wallet other than the KMS wallet");
  const d = q.details as J;
  if (!d || !sameAddr(d.recipient, owner) || !sameAddr(d.sender, owner))
    fail("details sender/recipient differ");
  const cin = d.currencyIn as J;
  const cout = d.currencyOut as J;
  if (
    Number(cin?.currency?.chainId) !== BRIDGE_SOURCE_CHAIN ||
    !sameAddr(cin?.currency?.address, zeroAddress) ||
    uintStr(cin?.amount, "input amount") !== expected.amountWei
  )
    fail("input currency is not the requested native ETH amount on Arbitrum");
  if (
    Number(cout?.currency?.chainId) !== BRIDGE_DESTINATION_CHAIN ||
    !sameAddr(cout?.currency?.address, zeroAddress) ||
    cout?.currency?.symbol !== "MON" ||
    cout?.currency?.decimals !== 18 ||
    uintStr(cout?.minimumAmount, "details minimum") !== minimumOutWei
  )
    fail("output currency is not MON on chain 143 or disagrees with the order");
  const inputUsd = Number(cin.amountUsd);
  const outUsd = Number(cout.amountUsd);
  if (!(inputUsd > 0) || !(outUsd > 0)) fail("missing USD valuation");
  const minimumOutUsd =
    (outUsd * Number(minimumOutWei)) /
    Number(uintStr(cout.amount, "output amount"));
  if (minimumOutUsd * 10000 < inputUsd * Number(BRIDGE_MIN_OUT_RATIO_BPS))
    fail(
      `guaranteed output ($${minimumOutUsd.toFixed(4)}) is below 90% of the input ($${inputUsd.toFixed(4)})`,
    );
  const fees = Object.entries((q.fees ?? {}) as J).map(([name, fee]) => ({
    name,
    amount: String(fee?.amountFormatted ?? "?"),
    symbol: String(fee?.currency?.symbol ?? "?"),
    usd: String(fee?.amountUsd ?? "?"),
  }));
  const check = (step.items[0] as J).check as J;
  const statusPath = `/intents/status?requestId=${q.requestId}`;
  if (check?.endpoint && check.endpoint !== statusPath)
    fail("unexpected status endpoint");
  return {
    requestId: q.requestId,
    orderId,
    chainId: BRIDGE_SOURCE_CHAIN,
    destinationChainId: BRIDGE_DESTINATION_CHAIN,
    from: owner,
    recipient: owner,
    to: RELAY_ARBITRUM_DEPOSITORY,
    data,
    value: expected.amountWei,
    expectedOutWei,
    minimumOutWei,
    inputUsd,
    minimumOutUsd,
    fees,
    deadline,
    timeEstimateSeconds: Number(d.timeEstimate ?? 0),
    statusPath,
  };
}
