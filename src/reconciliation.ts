import {
  type Hex,
  type PublicClient,
  TransactionReceiptNotFoundError,
} from "viem";
import { same, type ChainConfig, type Settings } from "./config.js";
import { Journal } from "./state.js";
import {
  HistoryStore,
  receiptSchema,
  type ExecutionRecord,
} from "./history.js";
import { executionReceipt } from "./execution-history.js";
import { valueSettlementFees } from "./settlement-economics.js";
import { safeError } from "./diagnostics.js";

export interface ReconciliationOptions {
  dryRun?: boolean;
  expectedHash?: string;
  requireFeeEvidence?: boolean;
  onIssue?: (issue: { hash: string; stage: string; reason: string }) => void;
  onVerified?: (proof: {
    hash: string;
    status: "confirmed" | "reverted";
    receipt: NonNullable<ExecutionRecord["receipt"]> | null;
    alreadySettled: boolean;
  }) => void;
}

/** Receipt-only path. No wallet, signer, authorization or broadcast module is imported. */
export async function reconcile(
  client: PublicClient,
  chain: ChainConfig,
  settings: Settings,
  journal: Journal,
  history?: HistoryStore,
  options: ReconciliationOptions = {},
): Promise<boolean> {
  const config = settings.execution[String(chain.chainId)];
  if (!config) return !options.expectedHash;
  const key = `${chain.chainId}:${config.operator.toLowerCase()}`;
  const entry = journal.get(key);
  const originalEntry = JSON.stringify(entry);
  const pending = entry.pending;
  const hash = pending?.hash ?? options.expectedHash;
  if (!hash) return true;
  let stage = "identity";
  try {
    if (
      !/^0x[0-9a-fA-F]{64}$/.test(hash) ||
      (options.expectedHash && !same(options.expectedHash, hash))
    )
      throw new Error(
        "The requested receipt does not match the pending transaction",
      );
    if ((await client.getChainId()) !== chain.chainId)
      throw new Error("Receipt RPC chain mismatch");
    stage = "receipt";
    const receipt = await client.getTransactionReceipt({ hash: hash as Hex });
    if (
      !same(receipt.transactionHash, hash) ||
      !same(receipt.from, config.operator) ||
      !receipt.to ||
      !same(receipt.to, config.executor)
    )
      throw new Error(
        "Receipt sender, target or hash differs from the configured account",
      );
    const head = await client.getBlockNumber();
    if (
      head < receipt.blockNumber ||
      head - receipt.blockNumber + 1n < BigInt(settings.confirmations)
    )
      return false;
    const canonical = await client.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (canonical.hash !== receipt.blockHash)
      throw new Error("Receipt block is not canonical");
    const tx = await client.getTransaction({ hash: hash as Hex });
    if (
      !same(tx.hash, hash) ||
      !same(tx.from, config.operator) ||
      !tx.to ||
      !same(tx.to, config.executor) ||
      tx.blockHash !== receipt.blockHash ||
      tx.blockNumber !== receipt.blockNumber ||
      (pending && tx.nonce !== pending.nonce)
    )
      throw new Error(
        "Mined transaction does not match the saved nonce and receipt",
      );
    stage = "history";
    const prepared = history?.get(settings.networkMode, chain.chainId, hash);
    if (
      (pending?.historyRequired ||
        options.expectedHash ||
        options.requireFeeEvidence) &&
      !prepared
    )
      throw new Error("Required execution history is missing");
    if (!pending && (!prepared?.receipt || prepared.status === "pending"))
      throw new Error("No matching pending journal or settled history record");
    if (
      prepared &&
      (!same(prepared.operator, config.operator) ||
        !same(prepared.executor, config.executor) ||
        (pending && !same(prepared.tradeId, pending.id)))
    )
      throw new Error(
        "Prepared history identity differs from the pending journal",
      );
    const status = receipt.status === "success" ? "confirmed" : "reverted";
    let valued: NonNullable<ExecutionRecord["receipt"]> | null = null;
    if (prepared && history) {
      stage = "decode";
      const decoded = executionReceipt(
        prepared,
        receipt,
        canonical.timestamp,
        chain,
      );
      if (
        prepared.receipt &&
        (prepared.receipt.blockHash !== receipt.blockHash ||
          prepared.status !== status)
      )
        throw new Error(
          "Stored receipt changed; manual canonicality review required",
        );
      stage = "fees";
      if (prepared.receipt?.feeValuation && !prepared.receipt.feeIssue) {
        const canonicalFacts = receiptSchema.parse(decoded);
        for (const field of [
          "blockHash",
          "blockNumber",
          "blockTimestamp",
          "logIndex",
          "grossProfit",
          "executionGasNative",
          "swapVM",
          "settlements",
        ] as const)
          if (
            JSON.stringify(prepared.receipt[field]) !==
            JSON.stringify(canonicalFacts[field])
          )
            throw new Error(
              "Stored receipt evidence differs from the canonical receipt",
            );
        valued = prepared.receipt;
      } else {
        valued = await valueSettlementFees(client, prepared, receipt, decoded);
      }
      if (
        options.requireFeeEvidence &&
        (!valued.feeValuation || valued.feeIssue)
      )
        throw new Error(
          "Complete historical fee evidence is required for this recovery",
        );
    }
    stage = "canonicality";
    if (
      (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !==
      receipt.blockHash
    )
      throw new Error("Receipt block changed while fees were being verified");
    if (JSON.stringify(journal.get(key)) !== originalEntry)
      throw new Error("Pending journal changed during receipt verification");
    options.onVerified?.({
      hash,
      status,
      receipt: valued,
      alreadySettled: !pending,
    });
    if (options.dryRun || !pending) return true;
    stage = "persist-history";
    if (prepared && history && valued) {
      history.settle(settings.networkMode, chain.chainId, hash, status, valued);
      const saved = history.get(settings.networkMode, chain.chainId, hash);
      if (
        saved?.status !== status ||
        saved.receipt?.blockHash !== receipt.blockHash
      )
        throw new Error(
          "Receipt history did not persist before journal release",
        );
    }
    stage = "persist-journal";
    const { pending: _, ...rest } = entry;
    journal.set(key, {
      ...rest,
      errors: receipt.status === "success" ? 0 : entry.errors + 1,
    });
    return true;
  } catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) {
      try {
        options.onIssue?.({ hash, stage, reason: safeError(error) });
      } catch {
        /* Diagnostics cannot release pending state. */
      }
    }
    return false;
  }
}
