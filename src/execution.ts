import { waitForRpcHead } from "./rpc-head.js";
import {
  assertEconomicExecution,
  verifyEconomicAnchors,
} from "./economic-gate.js";
import {
  createWalletClient,
  http,
  keccak256,
  type PublicClient,
  type Hex,
} from "viem";
import { workerAccount } from "./worker-account.js";
import type { KmsTransport } from "./kms-account.js";
import { executorAbi } from "./abi.js";
import { rpcUrl, same, type ChainConfig, type Settings } from "./config.js";
import { assertFresh, type Candidate } from "./strategy.js";
import { finalizeCandidateFees, assertFeeEstimateFresh } from "./live-fees.js";
import { Journal } from "./state.js";
import { HistoryStore } from "./history.js";
import { preparedExecution } from "./execution-history.js";
export async function submit(
  client: PublicClient,
  chain: ChainConfig,
  settings: Settings,
  candidate: Candidate,
  journal: Journal,
  history?: HistoryStore,
  kmsTransport?: KmsTransport,
  beforeBroadcast?: (simulation?: { number: bigint; hash: Hex }) => void,
  onProgress?: (stage: string, details?: Record<string, unknown>) => void,
): Promise<Hex> {
  const config = settings.execution[String(chain.chainId)];
  if (settings.mode !== "execute" || !config?.allowBroadcast)
    throw new Error("Broadcast disabled");
  if (!chain.executionReviewed || chain.feeModel === "unsupported")
    throw new Error("Chain execution capability is not reviewed");
  assertEconomicExecution(history, settings.networkMode);
  await verifyEconomicAnchors(
    history,
    settings.networkMode,
    chain.chainId,
    client,
  );
  beforeBroadcast?.();
  assertEconomicExecution(history, settings.networkMode);
  if (
    config.externalPools &&
    [candidate.trade.first, candidate.trade.second].some(
      (leg) =>
        leg.venue === 1 &&
        !config.externalPools!.some((pool) => same(pool, leg.target)),
    )
  )
    throw new Error(
      "External pool is outside the explicitly configured pilot scope",
    );
  const account = await workerAccount(
    chain.chainId,
    config,
    process.env,
    kmsTransport,
  );
  if (!same(account.address, config.operator))
    throw new Error("Operator key mismatch");
  const [paused, operator, router, hook, permit2, limit, extended] =
    await Promise.all([
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "paused",
      }),
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "operators",
        args: [account.address],
      }),
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "universalRouter",
      }),
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "aqua0Hook",
      }),
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "permit2",
      }),
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "limits",
        args: [candidate.trade.first.tokenIn],
      }),
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "extendedV4Encoding",
      }),
    ]);
  if (
    extended !== chain.extendedV4Encoding ||
    paused ||
    !operator ||
    !same(router, chain.universalRouter) ||
    !same(hook, chain.aqua0Hook) ||
    !same(permit2, chain.permit2)
  )
    throw new Error("Executor deployment mismatch or paused");
  if (
    candidate.trade.first.amountIn > limit[0] ||
    candidate.trade.minProfit < limit[1]
  )
    throw new Error("Onchain risk limit mismatch");
  if ((await client.getChainId()) !== chain.chainId)
    throw new Error("RPC chain changed before submission");
  if (candidate.swapVM) {
    const venue = candidate.swapVM;
    const capability = await client.readContract({
      address: config.executor,
      abi: executorAbi,
      functionName: "supportsAquaSwapVM",
    });
    if (!capability)
      throw new Error("This executor version has no SwapVM support");
    const key = await client.readContract({
      address: config.executor,
      abi: executorAbi,
      functionName: "swapVMStrategyKey",
      args: [venue.router, venue.maker, venue.stableStrategyId],
    });
    const [routerPolicy, strategyPolicy] = await Promise.all([
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "swapVMRouters",
        args: [venue.router],
      }),
      client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "swapVMStrategies",
        args: [key],
      }),
    ]);
    if (
      !routerPolicy[3] ||
      !strategyPolicy[3] ||
      !same(routerPolicy[0], venue.aqua) ||
      routerPolicy[2] !== venue.slices ||
      strategyPolicy[2] !== venue.classId
    )
      throw new Error(
        "SwapVM execution is not owner-approved for this strategy/router",
      );
  }
  const onchainGasCap = await client.readContract({
    address: config.executor,
    abi: executorAbi,
    functionName: "maxGasPrice",
  });
  const nonce = await client.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  if (
    nonce !==
    (await client.getTransactionCount({
      address: account.address,
      blockTag: "latest",
    }))
  )
    throw new Error("Operator already has a pending nonce");
  let head = await waitForRpcHead(
    client,
    candidate.blockNumber,
    candidate.quotedAt + settings.maxQuoteAgeMs,
    { pollMs: settings.scheduling.headerPollMs },
  );
  const checkQuote = (current: typeof head) => {
    assertFresh(
      candidate,
      current.number,
      Date.now(),
      settings.maxQuoteAgeMs,
      settings.maxBlockLag,
    );
    if (candidate.trade.deadline <= current.timestamp + 5n)
      throw new Error("Authorization near expiry");
  };
  checkQuote(head);
  candidate.trade.validUntilBlock =
    (await client.readContract({
      address: config.executor,
      abi: executorAbi,
      functionName: "executionBlockNumber",
      blockNumber: head.number,
    })) + BigInt(config.validityBlocks ?? 2);
  onProgress?.("simulating");
  let fees = await finalizeCandidateFees(
    client,
    chain,
    config,
    candidate,
    head,
    nonce,
    limit[1],
    onchainGasCap,
  );
  const signingHead = await waitForRpcHead(
    client,
    fees.blockNumber,
    fees.observedAt + settings.maxQuoteAgeMs,
    { pollMs: settings.scheduling.headerPollMs },
  );
  if (candidate.trade.deadline <= signingHead.timestamp + 5n)
    throw new Error("Authorization near expiry during fee preparation");
  // A changed state requires a new whole-call estimate, conversion and simulation, not just old math.
  if (signingHead.hash !== head.hash) {
    head = signingHead;
    candidate.trade.validUntilBlock =
      (await client.readContract({
        address: config.executor,
        abi: executorAbi,
        functionName: "executionBlockNumber",
        blockNumber: head.number,
      })) + BigInt(config.validityBlocks ?? 2);
    fees = await finalizeCandidateFees(
      client,
      chain,
      config,
      candidate,
      head,
      nonce,
      limit[1],
      onchainGasCap,
    );
  }
  assertFeeEstimateFresh(
    fees,
    candidate,
    await waitForRpcHead(
      client,
      fees.blockNumber,
      fees.observedAt + settings.maxQuoteAgeMs,
      { pollMs: settings.scheduling.headerPollMs },
    ),
    Date.now(),
    settings.maxQuoteAgeMs,
    settings.maxBlockLag,
  );
  if (
    (await client.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    })) !== nonce ||
    (await client.getTransactionCount({
      address: account.address,
      blockTag: "latest",
    })) !== nonce
  )
    throw new Error("Operator nonce changed during fee estimation");
  const { data, gas, gasPrice } = fees;
  const simulatedAt = { number: fees.blockNumber, hash: fees.blockHash };
  onProgress?.("fee_estimated", {
    gasUnits: gas,
    gasPrice,
    additionalNative: fees.additionalNative,
    nativeCost: fees.nativeCost,
    tokenCost: fees.tokenCost,
    blockNumber: fees.blockNumber,
    blockHash: fees.blockHash,
    calldataHash: fees.calldataHash,
    estimatedNetProfit: candidate.netProfit,
    conversionPool: fees.conversionPool,
  });
  const wallet = createWalletClient({
    account,
    transport: http(rpcUrl(chain)),
  });
  beforeBroadcast?.(simulatedAt);
  assertEconomicExecution(history, settings.networkMode);
  onProgress?.("signing");
  const signed = await wallet.signTransaction({
    chain: null,
    chainId: chain.chainId,
    type: "legacy",
    to: config.executor,
    data,
    gas,
    gasPrice,
    nonce,
  });
  const [broadcastHead, canonicalProof] = await Promise.all([
    waitForRpcHead(
      client,
      fees.blockNumber,
      fees.observedAt + settings.maxQuoteAgeMs,
      { pollMs: settings.scheduling.headerPollMs },
    ),
    client.getBlock({ blockNumber: fees.blockNumber }),
  ]);
  assertFeeEstimateFresh(
    fees,
    candidate,
    broadcastHead,
    Date.now(),
    settings.maxQuoteAgeMs,
    settings.maxBlockLag,
  );
  if (
    canonicalProof.hash !== fees.blockHash ||
    candidate.trade.deadline <= broadcastHead.timestamp + 5n
  )
    throw new Error(
      "Execution proof reorganized or authorization expired during signing",
    );
  beforeBroadcast?.(simulatedAt);
  assertEconomicExecution(history, settings.networkMode);
  const hash = keccak256(signed);
  const journalKey = `${chain.chainId}:${account.address.toLowerCase()}`;
  // Persist the deterministic hash BEFORE broadcast. An uncertain response cannot cause a second send.
  history?.prepare(preparedExecution(chain, settings, candidate, hash));
  journal.reserve(
    journalKey,
    hash,
    nonce,
    candidate.trade.id,
    // Exposure reservation is not the cost used to decide profit. Preserve an OP extra-fee
    // ceiling for the daily-spend meter; Arbitrum posting fees are already in estimated gas.
    gas * gasPrice +
      (chain.feeModel === "op-stack" ? config.l1FeeReserveWei : 0n),
    config.maxDailyGasWei,
    history !== undefined,
  );
  onProgress?.("broadcasting", {
    transactionHash: hash,
    tradeId: candidate.trade.id,
  });
  await client.sendRawTransaction({ serializedTransaction: signed });
  history?.acknowledgeBroadcast(settings.networkMode, chain.chainId, hash);
  return hash;
}
export { reconcile } from "./reconciliation.js";
