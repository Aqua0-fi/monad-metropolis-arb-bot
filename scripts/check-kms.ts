import { getAddress } from "viem";
import { verifyKmsReadiness } from "../src/kms-account.js";

const keyId = process.env.MARKET_REBALANCER_KMS_KEY_ID;
const region = process.env.AWS_REGION;
const address = process.env.MARKET_REBALANCER_OPERATOR_ADDRESS;
if (!keyId || !region || !address)
  throw new Error(
    "Dedicated KMS key, region and expected operator address are required",
  );
// This signs only a random readiness message. It does not connect to an RPC or submit a transaction.
const proof = await verifyKmsReadiness({
  keyId,
  region,
  address: getAddress(address),
  chainId: 8453,
});
console.log(JSON.stringify(proof, null, 2));
