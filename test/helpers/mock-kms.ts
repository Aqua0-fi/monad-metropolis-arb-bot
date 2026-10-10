import { createPublicKey } from "node:crypto";
import type { PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { KmsTransport } from "../../src/kms-account.js";
export const MOCK_KMS_KEY =
  "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";
export function mockKms(wallet: PrivateKeyAccount) {
  const point = Buffer.from(wallet.publicKey.slice(4), "hex");
  const pub = createPublicKey({
    key: {
      kty: "EC",
      crv: "secp256k1",
      x: point.subarray(0, 32).toString("base64url"),
      y: point.subarray(32).toString("base64url"),
    },
    format: "jwk",
  }).export({ format: "der", type: "spki" });
  const digests: Hex[] = [];
  const integer = (hex: string) => {
    let bytes = Buffer.from(hex, "hex");
    while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
    if (bytes[0]! & 128) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([2, bytes.length]), bytes]);
  };
  const transport: KmsTransport = {
    async publicKey(keyId) {
      if (keyId !== MOCK_KMS_KEY) throw new Error("Unexpected test key");
      return {
        keyId,
        keySpec: "ECC_SECG_P256K1",
        keyUsage: "SIGN_VERIFY",
        der: pub,
      };
    },
    async signDigest(keyId, digest) {
      if (keyId !== MOCK_KMS_KEY || digest.length !== 32)
        throw new Error("Invalid test digest request");
      const hash = `0x${Buffer.from(digest).toString("hex")}` as Hex;
      digests.push(hash);
      const signature = await wallet.sign({ hash });
      const values = Buffer.concat([
        integer(signature.slice(2, 66)),
        integer(signature.slice(66, 130)),
      ]);
      return {
        keyId,
        algorithm: "ECDSA_SHA_256",
        der: Buffer.concat([Buffer.from([0x30, values.length]), values]),
      };
    },
  };
  return { transport, digests };
}
