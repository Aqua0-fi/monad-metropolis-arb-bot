import { privateKeyToAccount } from "viem/accounts";
import type { Hex, LocalAccount } from "viem";
import type { Settings } from "./config.js";
import { createKmsAccount, type KmsTransport } from "./kms-account.js";

export async function workerAccount(
  chainId: number,
  config: Settings["execution"][string],
  env: NodeJS.ProcessEnv = process.env,
  transport?: KmsTransport,
): Promise<LocalAccount> {
  if (config.kms) {
    if (config.privateKeyEnv) throw new Error("Ambiguous signer configuration");
    return createKmsAccount(
      {
        ...config.kms,
        chainId,
        address: config.operator,
        target: config.executor,
      },
      transport,
    );
  }
  if (!config.privateKeyEnv)
    throw new Error("No dedicated worker signer configured");
  const key = env[config.privateKeyEnv];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error("Missing dedicated local operator key");
  const account = privateKeyToAccount(key as Hex);
  if (account.address.toLowerCase() !== config.operator.toLowerCase())
    throw new Error("Operator key mismatch");
  return account;
}
