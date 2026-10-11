/**
 * Owner-run Arbitrum ETH -> Monad MON bridge (Relay) for the KMS wallet's Monad gas. Default: preview.
 * --send requires an interactive terminal and the typed phrase BRIDGE <amount> ETH TO MONAD.
 * The destination is always the same KMS wallet on chain 143; the amount is capped at 0.0015 ETH.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  formatEther,
  formatGwei,
  http,
  type Address,
  type PublicClient,
} from "viem";
import {
  BRIDGE_SOURCE_CHAIN,
  RELAY_API,
  RELAY_ARBITRUM_DEPOSITORY,
  bridgeAmount,
  relayQuoteRequest,
  validateRelayQuote,
} from "../src/owner-bridge.js";
import {
  loadPolicy,
  monadClient,
  rpcFrom,
  stateDirFrom,
  typedConfirmation,
} from "../src/owner-monad-cli.js";
import {
  DEFAULT_ARBITRUM_RPC,
  OwnerJournal,
  OwnerSafetyError,
  acquireOwnerLock,
  json,
  ownerIdentity,
  reconcileRecord,
  sendOwnerCall,
  type SendContext,
} from "../src/owner-tx.js";

const { values } = parseArgs({
  options: {
    "amount-eth": { type: "string", default: "0.001" },
    send: { type: "boolean", default: false },
    status: { type: "boolean", default: false },
    "monad-rpc": { type: "string" },
    "state-dir": { type: "string" },
  },
});
const ARBITRUM_MAX_GAS_PRICE = 500_000_000n; // 0.5 gwei
const ARBITRUM_MAX_GAS = 100_000n; // Relay's own estimate is ~33k
const ARBITRUM_RESERVE_WEI = 500_000_000_000_000n; // keep 0.0005 ETH for the Arbitrum pilot

async function relay(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${RELAY_API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : null,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok)
    throw new OwnerSafetyError(
      `Relay ${path.split("?")[0]} returned HTTP ${response.status}`,
    );
  if (text.length > 1_000_000)
    throw new OwnerSafetyError("Oversized Relay response");
  return JSON.parse(text);
}
async function main() {
  if (values.send && values.status)
    throw new OwnerSafetyError("Choose --send or --status");
  if (values.send && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new OwnerSafetyError(
      "Bridging requires the owner at an interactive terminal",
    );
  const amountWei = bridgeAmount(values["amount-eth"]);
  const policy = loadPolicy();
  const owner: Address = policy.owner;
  const arbitrum = createPublicClient({
    transport: http(DEFAULT_ARBITRUM_RPC, { timeout: 15_000, retryCount: 1 }),
  }) as PublicClient;
  if ((await arbitrum.getChainId()) !== BRIDGE_SOURCE_CHAIN)
    throw new OwnerSafetyError("Arbitrum RPC chain mismatch");
  const monad = monadClient(rpcFrom(values["monad-rpc"]));
  const stateDir = stateDirFrom(values["state-dir"]);
  const journal = new OwnerJournal(join(stateDir, "bridge-journal.json"), {
    chainId: BRIDGE_SOURCE_CHAIN,
    owner,
    scope: "arbitrum-to-monad-bridge",
  });
  if (values.status) {
    const last = journal.data.records.at(-1);
    if (!last) return console.log("No bridge deposit is recorded.");
    const requestId = last.id.replace(/^bridge:/, "");
    console.log(
      json({
        deposit: { id: last.id, hash: last.hash, phase: last.phase },
        relayStatus: await relay(
          `/intents/status?requestId=${requestId}`,
        ).catch(() => "unavailable"),
        monadBalanceMon: formatEther(
          await monad.getBalance({ address: owner }),
        ),
      }),
    );
    return;
  }
  const quote = await relay("/quote", relayQuoteRequest(owner, amountWei));
  const bridge = validateRelayQuote(quote, {
    owner,
    amountWei,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  const [code, balance, gasPrice, monBalance] = await Promise.all([
    arbitrum.getCode({ address: RELAY_ARBITRUM_DEPOSITORY }),
    arbitrum.getBalance({ address: owner }),
    arbitrum.getGasPrice(),
    monad.getBalance({ address: owner }),
  ]);
  if (!code || code === "0x")
    throw new OwnerSafetyError("The Relay depository has no code on Arbitrum");
  const gasEstimate = await arbitrum.estimateGas({
    account: owner,
    to: bridge.to,
    data: bridge.data,
    value: bridge.value,
  });
  const maxGasFee = ((gasEstimate * 12n) / 10n) * ((gasPrice * 12n) / 10n);
  console.log(
    json({
      bridge: "Relay (api.relay.link), Arbitrum -> Monad",
      sourceChainId: BRIDGE_SOURCE_CHAIN,
      sourceAmountEth: formatEther(bridge.value),
      sourceWallet: owner,
      depositContract: bridge.to,
      destinationChainId: bridge.destinationChainId,
      destinationAddress: bridge.recipient,
      destinationIsKmsWallet: bridge.recipient === owner,
      expectedMonOut: formatEther(bridge.expectedOutWei),
      minimumMonOut: formatEther(bridge.minimumOutWei),
      inputUsd: bridge.inputUsd,
      minimumOutUsd: Number(bridge.minimumOutUsd.toFixed(4)),
      relayFees: bridge.fees,
      arbitrumGasEstimate: String(gasEstimate),
      arbitrumGasPriceGwei: formatGwei(gasPrice),
      maxArbitrumGasFeeEth: formatEther(maxGasFee),
      walletEthBefore: formatEther(balance),
      walletMonOnMonadBefore: formatEther(monBalance),
      orderDeadline: new Date(bridge.deadline * 1000).toISOString(),
      timeEstimateSeconds: bridge.timeEstimateSeconds,
      requestId: bridge.requestId,
    }),
  );
  if (!values.send) {
    console.log(
      "PREVIEW ONLY. No credential was loaded and nothing was signed. Rerun with --send to bridge.",
    );
    return;
  }
  const phrase = `BRIDGE ${values["amount-eth"]} ETH TO MONAD`;
  if (
    !(await typedConfirmation(
      `This sends ${formatEther(bridge.value)} ETH from ${owner} on Arbitrum to Relay; MON is paid to the SAME wallet on Monad (143).`,
      phrase,
    ))
  ) {
    console.log("Cancelled. Nothing was signed.");
    process.exitCode = 1;
    return;
  }
  const identity = await ownerIdentity(
    "kms",
    arbitrum,
    DEFAULT_ARBITRUM_RPC,
    owner,
  );
  const release = acquireOwnerLock(join(stateDir, "bridge.lock"));
  try {
    const ctx: SendContext = {
      client: arbitrum,
      journal,
      chainId: BRIDGE_SOURCE_CHAIN,
      identity,
      gas: {
        maxFeePerGas: ARBITRUM_MAX_GAS_PRICE,
        priorityFeeWei: 0n,
        priceMarginBps: 12000n,
        gasMarginBps: 12000n,
        maxGas: ARBITRUM_MAX_GAS,
      },
      allowedTargets: [RELAY_ARBITRUM_DEPOSITORY],
      reserveWei: ARBITRUM_RESERVE_WEI,
      mode: "strict",
      log: (l) => console.log(l),
    };
    for (const record of journal.unresolved())
      await reconcileRecord(ctx, record);
    if (bridge.deadline < Math.floor(Date.now() / 1000) + 60)
      throw new OwnerSafetyError(
        "The quote expired while confirming; rerun to fetch a fresh one",
      );
    const record = await sendOwnerCall(ctx, {
      id: `bridge:${bridge.requestId}`,
      description: `Relay deposit of ${formatEther(bridge.value)} ETH for MON to ${owner} on Monad`,
      to: bridge.to,
      data: bridge.data,
      value: bridge.value,
    });
    console.log(
      `Deposit confirmed on Arbitrum: ${record.hash}. Waiting for Relay to pay out on Monad...`,
    );
    for (let i = 0; i < 36; i++) {
      const status = (await relay(bridge.statusPath).catch(() => null)) as {
        status?: string;
      } | null;
      if (
        status?.status &&
        ["success", "failure", "refund", "refunded"].includes(status.status)
      ) {
        console.log(`Relay status: ${status.status}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    console.log(
      `Owner MON balance on Monad: ${formatEther(await monad.getBalance({ address: owner }))}`,
    );
  } finally {
    release();
  }
}
main().catch((error) => {
  console.error(
    `Bridge stopped: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  console.error(
    "Keep runtime/monad-pilot/bridge-journal.json; --status is read-only and never resends.",
  );
  process.exitCode = 1;
});
