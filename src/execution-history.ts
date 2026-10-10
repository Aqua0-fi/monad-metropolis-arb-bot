import {
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type TransactionReceipt,
} from "viem";
import { executorAbi, poolTuple } from "./abi.js";
// decodeEventLog selects by topic from the supplied ABI. Its eventName type hint does not
// filter runtime topics, so each independent receipt fact needs its own ABI projection.
const executedEventAbi = executorAbi.filter(
  (item) => item.type === "event" && item.name === "Executed",
);
const swapVMLegEventAbi = executorAbi.filter(
  (item) => item.type === "event" && item.name === "SwapVMLegExecuted",
);

import { same, type ChainConfig, type Settings } from "./config.js";
import type { Candidate } from "./strategy.js";
import type { ExecutionRecord } from "./history.js";

const settlementAbi = parseAbi([
  "event V4SwapSettled(address indexed adapter,uint256 indexed strategyId,bytes32 indexed swapId,address token0,int256 delta0,address token1,int256 delta1)",
]);
export function preparedExecution(
  chain: ChainConfig,
  settings: Settings,
  candidate: Candidate,
  hash: string,
): ExecutionRecord {
  const config = settings.execution[String(chain.chainId)];
  if (!config) throw new Error("Missing execution configuration");
  const aquaLeg = candidate.aquaFirst
    ? candidate.trade.first
    : candidate.trade.second;
  if (aquaLeg.venue !== 0 && (aquaLeg.venue !== 2 || !candidate.swapVM))
    throw new Error("Missing Aqua0 leg");
  return {
    version: 1,
    feePolicy: {
      feeModel: chain.feeModel,
      nativeCurrency: chain.nativeCurrency ?? null,
      nativeEquivalent: chain.nativeEquivalent ?? null,
      wrappedNative: config.wrappedNative,
      gasConversionFee:
        candidate.feeEstimate?.conversionFee ?? config.gasConversionFee,
      venues: chain.venues.map((v) => ({
        factory: v.factory,
        quoter: v.quoter,
      })),
    },
    network: settings.networkMode,
    chainId: chain.chainId,
    transactionHash: hash,
    tradeId: candidate.trade.id,
    executor: config.executor,
    operator: config.operator,
    venue: candidate.swapVM ? "aqua" : "v4",
    ...(candidate.swapVM
      ? {
          swapVM: {
            stableStrategyId: candidate.swapVM.stableStrategyId,
            classId: candidate.swapVM.classId.toString(),
            orderHash: candidate.swapVM.currentAquaHash,
            router: candidate.swapVM.router,
            maker: candidate.swapVM.maker,
            aqua: candidate.swapVM.aqua,
          },
        }
      : {}),
    poolId: candidate.swapVM
      ? null
      : keccak256(
          encodeAbiParameters(parseAbiParameters(poolTuple), [aquaLeg.pool]),
        ),
    aqua0Hook: candidate.swapVM?.maker ?? chain.aqua0Hook,
    tokenIn: candidate.trade.first.tokenIn,
    tokenOut: candidate.trade.first.tokenOut,
    amountIn: candidate.trade.first.amountIn.toString(),
    minimumProfit: candidate.trade.minProfit.toString(),
    quotedNetProfit: candidate.netProfit.toString(),
    aquaFirst: candidate.aquaFirst,
    preparedAt: new Date().toISOString(),
    status: "pending",
    broadcastAcknowledged: false,
    receipt: null,
  };
}

/** The receipt is already confirmed and its block hash checked by reconcile. Decode only the configured emitters. */
export function executionReceipt(
  record: ExecutionRecord,
  receipt: TransactionReceipt,
  blockTimestamp: bigint,
  chain: ChainConfig,
): NonNullable<ExecutionRecord["receipt"]> {
  if (
    !same(receipt.transactionHash, record.transactionHash) ||
    !receipt.to ||
    !same(receipt.to, record.executor)
  )
    throw new Error("Receipt transaction identity mismatch");
  let execution: { profit: bigint; logIndex: number } | undefined;
  let swapVM: NonNullable<ExecutionRecord["receipt"]>["swapVM"];
  const settlements: NonNullable<ExecutionRecord["receipt"]>["settlements"] =
    [];
  for (const log of receipt.logs) {
    if (log.logIndex === null)
      throw new Error("Mined receipt has no log index");
    if (same(log.address, record.executor)) {
      try {
        const event = decodeEventLog({
          abi: executedEventAbi,
          eventName: "Executed",
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        if (!same(event.args.id, record.tradeId)) continue;
        if (
          !same(event.args.token, record.tokenIn) ||
          event.args.input !== BigInt(record.amountIn) ||
          event.args.profit < BigInt(record.minimumProfit)
        )
          throw new Error("Executed event does not match the prepared trade");
        if (execution) throw new Error("Duplicate execution event");
        execution = { profit: event.args.profit, logIndex: log.logIndex };
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.startsWith("Executed event") ||
            error.message.startsWith("Duplicate execution"))
        )
          throw error;
      }
    }
    if (record.venue === "aqua" && same(log.address, record.executor)) {
      let decoded;
      try {
        decoded = decodeEventLog({
          abi: swapVMLegEventAbi,
          eventName: "SwapVMLegExecuted",
          data: log.data,
          topics: log.topics,
          strict: true,
        });
      } catch {
        /* Other executor events are handled independently. */
      }
      if (decoded) {
        const a = decoded.args,
          identity = record.swapVM!;
        if (
          swapVM ||
          !same(a.router, identity.router) ||
          !same(a.maker, identity.maker) ||
          !same(a.strategyId, identity.stableStrategyId) ||
          !same(a.orderHash, identity.orderHash) ||
          a.classId.toString() !== identity.classId ||
          !same(
            a.tokenIn,
            record.aquaFirst ? record.tokenIn : record.tokenOut,
          ) ||
          !same(
            a.tokenOut,
            record.aquaFirst ? record.tokenOut : record.tokenIn,
          ) ||
          a.amountIn <= 0n ||
          a.amountOut <= 0n
        )
          throw new Error("SwapVM receipt identity mismatch");
        swapVM = {
          router: a.router,
          maker: a.maker,
          strategyId: a.strategyId,
          orderHash: a.orderHash,
          classId: a.classId.toString(),
          tokenIn: a.tokenIn,
          tokenOut: a.tokenOut,
          amountIn: a.amountIn.toString(),
          amountOut: a.amountOut.toString(),
          logIndex: log.logIndex,
        };
      }
    }
    if (record.venue !== "aqua" && same(log.address, record.aqua0Hook)) {
      try {
        const event = decodeEventLog({
          abi: settlementAbi,
          eventName: "V4SwapSettled",
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        const a = event.args;
        if (!same(a.adapter, record.aqua0Hook)) continue;
        const pairMatches =
          (same(a.token0, record.tokenIn) && same(a.token1, record.tokenOut)) ||
          (same(a.token1, record.tokenIn) && same(a.token0, record.tokenOut));
        if (pairMatches)
          settlements.push({
            swapId: a.swapId,
            classId: a.strategyId.toString(),
            logIndex: log.logIndex,
            token0: a.token0,
            delta0: a.delta0.toString(),
            token1: a.token1,
            delta1: a.delta1.toString(),
          });
      } catch {
        /* Other hook events are not settlement evidence. */
      }
    }
  }
  if (receipt.status === "success" && record.venue === "aqua" && !swapVM)
    throw new Error("Successful SwapVM receipt has no matching venue event");
  if (receipt.status === "success" && !execution)
    throw new Error("Successful receipt has no matching execution event");
  if (
    receipt.status === "reverted" &&
    (execution || settlements.length || swapVM)
  )
    throw new Error("Reverted receipt contains settlement events");
  const executionGas = receipt.gasUsed * receipt.effectiveGasPrice;
  // Rollup receipt extensions vary. Never report a missing extra fee as zero or call execution gas the total.
  const extended = receipt as TransactionReceipt & {
    l1Fee?: bigint;
    operatorFee?: bigint;
  };
  const additional =
    chain.feeModel === "gas-limit"
      ? 0n
      : typeof extended.l1Fee === "bigint" &&
          typeof extended.operatorFee === "bigint"
        ? extended.l1Fee + extended.operatorFee
        : null;
  return {
    ...(swapVM ? { swapVM } : {}),
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    blockTimestamp: new Date(Number(blockTimestamp) * 1000).toISOString(),
    checkedAt: new Date().toISOString(),
    logIndex: execution?.logIndex ?? null,
    grossProfit: execution?.profit.toString() ?? null,
    executionGasNative: executionGas.toString(),
    additionalGasNative: additional?.toString() ?? null,
    totalGasNative:
      additional === null ? null : (executionGas + additional).toString(),
    settlements,
  };
}
