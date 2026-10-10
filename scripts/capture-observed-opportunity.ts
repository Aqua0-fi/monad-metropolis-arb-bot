import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, keccak256, type Hex } from "viem";

// Reuse the completed read-only scan. No private credentials, signing or fresh
// trade authorization is needed to preserve one quote for independent EVM replay.
const source =
  process.argv[2] ?? "../evidence/arbitrum-readonly-route-scan-20260929.json";
const destination =
  process.argv[3] ?? "config/observed-opportunity-arbitrum-fork.json";
const scan = JSON.parse(readFileSync(source, "utf8"));
const row = scan.records.find(
  (record: any) =>
    record.label?.kind === "aqua" &&
    record.http === 200 &&
    record.result?.candidates?.some((candidate: any) => candidate.aquaFirst),
);
if (!row || scan.chainId !== 42161)
  throw new Error("No captured Arbitrum Aqua-first candidate");
const quote = row.result;
const client = createPublicClient({
  transport: http("https://arb1.arbitrum.io/rpc", {
    timeout: 20_000,
    retryCount: 0,
  }),
});
if ((await client.getChainId()) !== 42161) throw new Error("Wrong RPC network");
const blockNumber = BigInt(quote.blockNumber);
const block = await client.getBlock({ blockNumber });
if (block.hash.toLowerCase() !== quote.blockHash.toLowerCase())
  throw new Error("Quote block is not canonical");
const makerCode = await client.getCode({
  address: quote.market.maker,
  blockNumber,
});
const executorCode = await client.getCode({
  address: quote.caller,
  blockNumber,
});
if (!makerCode || !executorCode || makerCode === "0x" || executorCode === "0x")
  throw new Error("Missing captured deployment");
const fixture = {
  source,
  capturedAt: new Date().toISOString(),
  quote,
  expectedOwner: "0xd1fC4c8631E8C5d23a0C86D5890802DD70Cb4cf5",
  expectedMakerCodeHash: keccak256(makerCode as Hex),
  expectedExecutorCodeHash: keccak256(executorCode as Hex),
  externalQuoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  qualification:
    "Observed pool prices and actual deployed maker/vault/executor. Fork-only operating funds and permissions. No external-price displacement, public transaction or signature.",
};
writeFileSync(destination, `${JSON.stringify(fixture, null, 2)}\n`, {
  mode: 0o600,
});
console.log(
  JSON.stringify(
    {
      destination,
      chainId: 42161,
      block: quote.blockNumber,
      strategy: quote.market.stableStrategyId,
      executor: quote.caller,
      quotedCandidates: quote.candidates,
      publicTransactions: 0,
    },
    null,
    2,
  ),
);
