import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { encodeDeployData, type Abi } from "viem";
import { address, loadChains, zero } from "../src/config.js";
const { values } = parseArgs({
  options: { chain: { type: "string" }, owner: { type: "string" } },
});
const chain = loadChains().find((c) => String(c.chainId) === values.chain);
if (!chain) throw new Error("Specify a supported --chain");
const owner = address.parse(values.owner);
if (owner === zero) throw new Error("Owner must not be zero");
const artifact = JSON.parse(
  readFileSync("out/MarketRebalancer.sol/MarketRebalancer.json", "utf8"),
) as { abi: Abi; bytecode: { object: `0x${string}` } };
console.log(
  JSON.stringify(
    {
      service: "market-rebalancer-service",
      chainId: chain.chainId,
      owner,
      broadcast: false,
      deploymentData: encodeDeployData({
        abi: artifact.abi,
        bytecode: artifact.bytecode.object,
        args: [
          owner,
          chain.universalRouter,
          chain.permit2,
          chain.aqua0Hook,
          chain.extendedV4Encoding,
        ],
      }),
      configurationOrder: [
        "setOperator",
        "setGasPriceLimit",
        "setAquaPool",
        "setV3Pool",
        "setLimits",
        "fund bounded inventory",
        "verify API authorization and fork simulation",
        "setPaused(false)",
      ],
      note: "Deploys paused. Only the owner can configure or withdraw. No funds are sent by this script.",
    },
    null,
    2,
  ),
);
