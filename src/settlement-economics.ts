import {
  parseAbi,
  erc20Abi,
  zeroAddress,
  type PublicClient,
  type Address,
  type TransactionReceipt,
} from "viem";
import { same } from "./config.js";
import type { ExecutionRecord } from "./history.js";
import type { FeeValuation } from "./economics.js";
const GAS_ORACLE = "0x420000000000000000000000000000000000000F" as const;
const oracleAbi = parseAbi([
  "function getOperatorFee(uint256 gasUsed) view returns(uint256)",
]);
const identityAbi = parseAbi([
  "function factory() view returns(address)",
  "function getPool(address,address,uint24) view returns(address)",
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function fee() view returns(uint24)",
]);
const exactOutputAbi = parseAbi([
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)",
]);
function rawUint(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))
    throw Error("Missing or invalid raw fee field");
  return BigInt(value);
}
/** Strictly associate provider-specific fee fields with the same already-verified receipt. */
export function checkedL1Fee(
  raw: unknown,
  receipt: TransactionReceipt,
): bigint {
  if (!raw || typeof raw !== "object") throw Error("Missing raw receipt");
  const r = raw as Record<string, unknown>;
  for (const field of ["transactionHash", "blockHash", "from", "to"] as const) {
    if (
      typeof r[field] !== "string" ||
      !receipt[field] ||
      !same(r[field] as string, receipt[field]!)
    )
      throw Error("Raw fee receipt identity mismatch");
  }
  if (
    rawUint(r.blockNumber) !== receipt.blockNumber ||
    rawUint(r.gasUsed) !== receipt.gasUsed ||
    rawUint(r.effectiveGasPrice) !== receipt.effectiveGasPrice ||
    rawUint(r.status) !== (receipt.status === "success" ? 1n : 0n)
  )
    throw Error("Raw fee receipt fields mismatch");
  return rawUint(r.l1Fee);
}
export async function valueSettlementFees(
  client: PublicClient,
  record: ExecutionRecord,
  receipt: TransactionReceipt,
  decoded: NonNullable<ExecutionRecord["receipt"]>,
): Promise<NonNullable<ExecutionRecord["receipt"]>> {
  const result = {
    ...decoded,
    feeValuation: null as FeeValuation | null,
    feeIssue: null as string | null,
  };
  try {
    const policy = record.feePolicy;
    if (policy?.feeModel === "op-stack") {
      result.additionalGasNative = null;
      result.totalGasNative = null;
    }
    if (!policy || !policy.nativeCurrency || policy.feeModel === "unsupported")
      throw Error("Recorded fee policy unavailable");
    if (
      !same(receipt.transactionHash, record.transactionHash) ||
      !same(receipt.blockHash, decoded.blockHash) ||
      String(receipt.blockNumber) !== decoded.blockNumber
    )
      throw Error("Receipt identity mismatch");
    const blockNumber = receipt.blockNumber;
    if ((await client.getBlock({ blockNumber })).hash !== receipt.blockHash)
      throw Error("Receipt block no longer canonical");
    let additional = 0n;
    if (policy.feeModel === "op-stack") {
      // The generic viem formatter may not retain OP-specific fields. Read the SAME receipt raw.
      const raw = await client.request({
        method: "eth_getTransactionReceipt",
        params: [receipt.transactionHash],
      });
      const l1 = checkedL1Fee(raw, receipt);
      // Calling the historical oracle avoids hard-coding a fee formula across OP upgrades.
      const operator = await client.readContract({
        address: GAS_ORACLE,
        abi: oracleAbi,
        functionName: "getOperatorFee",
        args: [receipt.gasUsed],
        blockNumber,
      });
      const supplied = (raw as unknown as Record<string, unknown>).operatorFee;
      if (supplied !== undefined && rawUint(supplied) !== operator)
        throw Error("Operator fee mismatch");
      additional = l1 + operator;
    }
    const native = receipt.gasUsed * receipt.effectiveGasPrice + additional;
    result.executionGasNative = String(
      receipt.gasUsed * receipt.effectiveGasPrice,
    );
    result.additionalGasNative = String(additional);
    result.totalGasNative = String(native);
    const nativeAsset = policy.nativeEquivalent ?? {
      token: policy.wrappedNative,
      decimals: policy.nativeCurrency.decimals,
    };
    if (!same(nativeAsset.token, policy.wrappedNative))
      throw Error("Gas-equivalent token mismatch");
    const denominator = 10n ** BigInt(policy.nativeCurrency.decimals);
    const gasAmount =
      (native * 10n ** BigInt(nativeAsset.decimals) + denominator - 1n) /
      denominator;
    const input = record.tokenIn as Address,
      gasToken = nativeAsset.token as Address;
    const [decimals, symbol, gasDecimals] = await Promise.all([
      client.readContract({
        address: input,
        abi: erc20Abi,
        functionName: "decimals",
        blockNumber,
      }),
      client.readContract({
        address: input,
        abi: erc20Abi,
        functionName: "symbol",
        blockNumber,
      }),
      client.readContract({
        address: gasToken,
        abi: erc20Abi,
        functionName: "decimals",
        blockNumber,
      }),
    ]);
    if (
      decimals > 36 ||
      gasDecimals !== nativeAsset.decimals ||
      !symbol ||
      symbol.length > 32
    )
      throw Error("Token metadata mismatch");
    let tokenCost: bigint;
    let chosen: { quoter: Address; pool: Address } | null = null;
    if (same(input, gasToken)) {
      tokenCost = gasAmount;
    } else {
      let quoted: bigint | undefined;
      for (const venue of policy.venues) {
        const factory = venue.factory as Address,
          quoter = venue.quoter as Address;
        const pool = await client.readContract({
          address: factory,
          abi: identityAbi,
          functionName: "getPool",
          args: [input, gasToken, policy.gasConversionFee],
          blockNumber,
        });
        if (same(pool, zeroAddress)) continue;
        const [qf, pf, t0, t1, fee] = await Promise.all([
          client.readContract({
            address: quoter,
            abi: identityAbi,
            functionName: "factory",
            blockNumber,
          }),
          client.readContract({
            address: pool,
            abi: identityAbi,
            functionName: "factory",
            blockNumber,
          }),
          client.readContract({
            address: pool,
            abi: identityAbi,
            functionName: "token0",
            blockNumber,
          }),
          client.readContract({
            address: pool,
            abi: identityAbi,
            functionName: "token1",
            blockNumber,
          }),
          client.readContract({
            address: pool,
            abi: identityAbi,
            functionName: "fee",
            blockNumber,
          }),
        ]);
        if (
          !same(qf, factory) ||
          !same(pf, factory) ||
          fee !== policy.gasConversionFee ||
          ![t0, t1].some((x) => same(x, input)) ||
          ![t0, t1].some((x) => same(x, gasToken))
        )
          throw Error("Fee conversion venue identity mismatch");
        if (gasAmount === 0n) quoted = 0n;
        else {
          const { result: answer } = await client.simulateContract({
            address: quoter,
            abi: exactOutputAbi,
            functionName: "quoteExactOutputSingle",
            args: [
              {
                tokenIn: input,
                tokenOut: gasToken,
                amount: gasAmount,
                fee: policy.gasConversionFee,
                sqrtPriceLimitX96: 0n,
              },
            ],
            blockNumber,
          });
          quoted = answer[0];
          if (quoted === 0n) throw Error("Zero historical fee conversion");
        }
        chosen = { quoter, pool };
        break;
      }
      if (quoted === undefined)
        throw Error("No reviewed historical gas-conversion pool");
      tokenCost = quoted;
    }
    if ((await client.getBlock({ blockNumber })).hash !== receipt.blockHash)
      throw Error("Fee valuation block reorganized");
    result.feeValuation = {
      version: 1,
      token: record.tokenIn,
      tokenCost: String(tokenCost),
      nativeCost: String(native),
      blockNumber: String(blockNumber),
      blockHash: receipt.blockHash.toLowerCase(),
      tokenDecimals: decimals,
      tokenSymbol: symbol,
      nativeDecimals: policy.nativeCurrency.decimals,
      nativeSymbol: policy.nativeCurrency.symbol,
      method: chosen ? "v3-exact-output" : "native-equivalent",
      conversionToken: gasToken.toLowerCase(),
      conversionAmount: String(gasAmount),
      quoter: chosen?.quoter.toLowerCase() ?? null,
      pool: chosen?.pool.toLowerCase() ?? null,
      fee: chosen ? policy.gasConversionFee : null,
    };
  } catch {
    result.feeIssue =
      "Historical fee evidence or conversion is unavailable; no zero-cost assumption was made.";
  }
  return result;
}
