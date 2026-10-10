import {
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  parseAbi,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import type { ChainConfig } from "./config.js";
const setupAbi = parseAbi([
  "function setOperator(address,bool)",
  "function setGasPriceLimit(uint256)",
  "function setLimits(address,uint256,uint256)",
]);
export function buildUnsignedArbitrumLaunch(p: {
  chain: ChainConfig;
  artifact: { abi: Abi; bytecode: { object: Hex } };
  owner: Address;
  operator: Address;
  nonce: bigint;
  usdc: Address;
  minGrossProfit: bigint;
  gasPriceCap: bigint;
}) {
  if (
    p.chain.chainId !== 42161 ||
    !p.chain.executionReviewed ||
    p.nonce < 0n ||
    p.minGrossProfit <= 0n ||
    p.gasPriceCap <= 0n
  )
    throw new Error("Invalid Arbitrum launch scope or limits");
  const owner = getAddress(p.owner),
    operator = getAddress(p.operator),
    usdc = getAddress(p.usdc);
  if ([owner, operator, usdc].includes(zeroAddress))
    throw new Error("Zero launch identity");
  if (
    !/^0x[0-9a-fA-F]+$/.test(p.artifact.bytecode.object) ||
    p.artifact.bytecode.object.length % 2 !== 0
  )
    throw new Error("Unlinked or missing deployment bytecode");
  const executor = getContractAddress({ from: owner, nonce: p.nonce });
  const data = encodeDeployData({
    abi: p.artifact.abi,
    bytecode: p.artifact.bytecode.object,
    args: [
      owner,
      p.chain.universalRouter,
      p.chain.permit2,
      p.chain.aqua0Hook,
      p.chain.extendedV4Encoding,
    ],
  });
  const calls = [
    encodeFunctionData({
      abi: setupAbi,
      functionName: "setOperator",
      args: [operator, true],
    }),
    encodeFunctionData({
      abi: setupAbi,
      functionName: "setGasPriceLimit",
      args: [p.gasPriceCap],
    }),
    encodeFunctionData({
      abi: setupAbi,
      functionName: "setLimits",
      args: [usdc, 5_000_000n, p.minGrossProfit],
    }),
  ];
  return {
    version: 1,
    service: "market-rebalancer-service",
    chainId: 42161,
    mode: "observe",
    broadcast: false,
    owner,
    operator,
    startingToken: usdc,
    inputCapRaw: "5000000",
    inputCapMeaning:
      "5 native USDC at six decimals; not a universal USD cap for arbitrary tokens",
    executorDeployed: false,
    predictedExecutor: executor,
    predictedNonce: p.nonce.toString(),
    deployment: {
      from: owner,
      chainId: 42161,
      nonce: p.nonce.toString(),
      data,
      value: "0",
    },
    ownerSetup: calls.map((data) => ({
      from: owner,
      to: executor,
      chainId: 42161,
      data,
      value: "0",
    })),
    requiredNextChecks: [
      "The predicted address changes if the owner sends any earlier transaction. Rebuild this draft immediately before deployment.",
      "Check actual deployment receipt, code and constructor bindings before sending any setup call.",
      "Select and verify one real Aqua0 pool or SwapVM strategy and its exact external pool; this package grants no market permission.",
      "Transfer only deliberately chosen inventory after code and owner verification; token funding is not included in this package.",
      "Configure current backend credentials, fee budgets and a full-route simulation. The worker and contract remain paused for execution.",
      "Only the operator should trade. An owner/operator shared key also has withdrawal power; protect its KMS authorization accordingly.",
    ],
  };
}
