import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  http,
  getAddress,
  parseAbi,
  formatEther,
  keccak256,
} from "viem";
import { loadChains } from "../src/config.js";
import { buildUnsignedArbitrumLaunch } from "../src/launch-plan.js";
// Read-only RPC calls and unsigned output only. This file never creates a wallet or accesses KMS.
const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    operator: { type: "string" },
    output: {
      type: "string",
      default: "evidence/arbitrum-unsigned-launch.json",
    },
  },
});
if (!values.owner) throw new Error("Provide --owner explicitly");
const owner = getAddress(values.owner),
  operator = getAddress(values.operator ?? values.owner);
const chain = loadChains().find((c) => c.chainId === 42161)!;
const rpc = createPublicClient({
  transport: http(process.env[chain.rpcEnv] ?? chain.publicRpc, {
    timeout: 15000,
    retryCount: 1,
  }),
});
if ((await rpc.getChainId()) !== 42161) throw new Error("RPC chain mismatch");
const block = await rpc.getBlock();
const nonce = await rpc.getTransactionCount({
  address: owner,
  blockTag: "pending",
});
const baseNonce = await rpc.getTransactionCount({
  address: owner,
  blockNumber: block.number,
});
if (nonce !== baseNonce)
  throw new Error(
    "Owner has pending transactions; wait and rebuild the deployment draft",
  );
const balance = await rpc.getBalance({
  address: owner,
  blockNumber: block.number,
});
const gasPrice = await rpc.getGasPrice();
// Resolve native USDC from the checked registry pool, then verify decimals and the known symbol onchain.
const candidates = [
  ...new Set(chain.pools.flatMap((p) => [p.currency0, p.currency1])),
];
const abi = parseAbi([
  "function symbol() view returns(string)",
  "function decimals() view returns(uint8)",
]);
let usdc: typeof owner | undefined;
for (const address of candidates) {
  const [symbol, decimals] = await Promise.all([
    rpc.readContract({
      address,
      abi,
      functionName: "symbol",
      blockNumber: block.number,
    }),
    rpc.readContract({
      address,
      abi,
      functionName: "decimals",
      blockNumber: block.number,
    }),
  ]);
  if (symbol === "USDC" && decimals === 6) {
    if (usdc) throw new Error("Ambiguous registry USDC");
    usdc = address;
  }
}
if (!usdc) throw new Error("No registry USDC verified");
const artifact = JSON.parse(
  readFileSync("out/MarketRebalancer.sol/MarketRebalancer.json", "utf8"),
);
const metadata =
  typeof artifact.metadata === "string"
    ? JSON.parse(artifact.metadata)
    : artifact.metadata;
if (!metadata.compiler.version.startsWith("0.8.37"))
  throw new Error("Unexpected reviewed compiler");
const draft = buildUnsignedArbitrumLaunch({
  chain,
  artifact,
  owner,
  operator,
  nonce: BigInt(nonce),
  usdc,
  minGrossProfit: 10000n,
  gasPriceCap: gasPrice * 2n,
});
let estimate: unknown = {
  available: false,
  note: "Deployment gas estimate unavailable; do not infer a funding requirement.",
};
try {
  const gas = await rpc.estimateGas({
    account: owner,
    data: draft.deployment.data,
  });
  estimate = {
    available: true,
    gasUnits: gas.toString(),
    observedGasPriceWei: gasPrice.toString(),
    estimatedNativeFeeWei: (gas * gasPrice).toString(),
    estimatedEth: formatEther(gas * gasPrice),
    basis:
      "RPC estimate for deployment only; excludes setup, inventory and later trades",
  };
} catch {
  /* A zero-balance account or provider can refuse estimation. Do not guess. */
}
const result = {
  ...draft,
  capturedAt: new Date().toISOString(),
  blockNumber: block.number.toString(),
  blockHash: block.hash,
  operatorEthBalance: formatEther(balance),
  compiler: metadata.compiler.version,
  creationCodeHash: keccak256(artifact.bytecode.object),
  deploymentFeeEstimate: estimate,
  signaturesProduced: 0,
  publicTransactions: 0,
};
writeFileSync(values.output!, JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      output: values.output,
      owner,
      predictedExecutor: draft.predictedExecutor,
      balance: result.operatorEthBalance,
      fee: estimate,
      signaturesProduced: 0,
      publicTransactions: 0,
    },
    null,
    2,
  ),
);
