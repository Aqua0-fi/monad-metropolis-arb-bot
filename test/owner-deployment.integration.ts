import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createPublicClient,
  http,
  encodeDeployData,
  keccak256,
  serializeTransaction,
  parseAbi,
  getAddress,
  type Hex,
  type Abi,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createOwnerDeploymentAccount } from "../src/kms-account.js";
import {
  normalizeRuntime,
  assertCreationBudget,
  type RuntimeArtifact,
} from "../src/owner-deployment.js";
import { mockKms, MOCK_KMS_KEY } from "./helpers/mock-kms.js";

// No fork and no AWS client: chain ID is simulated on a freshly spawned loopback-only Anvil.
test(
  "owner-reviewed synthetic KMS creation mines the exact paused runtime on a private local EVM",
  { timeout: 45000 },
  async () => {
    const reserve = createServer();
    await new Promise<void>((yes, no) => {
      reserve.once("error", no);
      reserve.listen(0, "127.0.0.1", yes);
    });
    const bound = reserve.address();
    assert(bound && typeof bound !== "string");
    const port = bound.port;
    await new Promise<void>((yes, no) =>
      reserve.close((e) => (e ? no(e) : yes())),
    );
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(
      "anvil",
      [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--chain-id",
        "42161",
        "--silent",
      ],
      { stdio: "ignore" },
    );
    let launchError: Error | undefined;
    child.once("error", (error) => {
      launchError = error;
    });
    const rpc = createPublicClient({
      transport: http(url, { timeout: 3000, retryCount: 0 }),
      cacheTime: 0,
    });
    const synthetic = privateKeyToAccount(generatePrivateKey());
    const kms = mockKms(synthetic);
    const artifact = JSON.parse(
      readFileSync("out/MarketRebalancer.sol/MarketRebalancer.json", "utf8"),
    ) as {
      abi: Abi;
      bytecode: { object: Hex };
      deployedBytecode: RuntimeArtifact;
    };
    const bindings = [
      "0x0000000000000000000000000000000000001001",
      "0x0000000000000000000000000000000000001002",
      "0x0000000000000000000000000000000000001003",
    ] as const;
    async function local(method: string, params: unknown[]) {
      assert.equal(new URL(url).hostname, "127.0.0.1");
      const reply = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = (await reply.json()) as { error?: unknown };
      assert.equal(body.error, undefined);
    }
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (launchError) throw launchError;
        if (child.exitCode !== null)
          throw new Error("Owned local test node exited");
        try {
          assert.equal(await rpc.getChainId(), 42161);
          ready = true;
          break;
        } catch {
          await sleep(50);
        }
      }
      assert(ready, "Local EVM did not start");
      await local("anvil_setBalance", [
        synthetic.address,
        "0x8ac7230489e80000",
      ]);
      for (const address of bindings)
        await local("anvil_setCode", [address, "0x00"]);
      const data = encodeDeployData({
        abi: artifact.abi,
        bytecode: artifact.bytecode.object,
        args: [synthetic.address, ...bindings, false],
      });
      const estimate = await rpc.estimateGas({
        account: synthetic.address,
        data,
      });
      const tx = {
        type: "eip1559" as const,
        chainId: 42161,
        nonce: 0,
        gas: (estimate * 12n) / 10n,
        maxFeePerGas: (await rpc.getGasPrice()) * 2n,
        maxPriorityFeePerGas: 0n,
        value: 0n,
        data,
      };
      assertCreationBudget(tx, 10n ** 18n);
      const signer = await createOwnerDeploymentAccount(
        {
          keyId: MOCK_KMS_KEY,
          region: "us-east-1",
          address: synthetic.address,
          chainId: 42161,
        },
        keccak256(serializeTransaction(tx)),
        kms.transport,
      );
      assert.equal(kms.digests.length, 0);
      const signed = await signer.signTransaction(tx);
      const hash = await rpc.sendRawTransaction({
        serializedTransaction: signed,
      });
      assert.equal(hash, keccak256(signed));
      const receipt = await rpc.waitForTransactionReceipt({
        hash,
        timeout: 15000,
        pollingInterval: 100,
      });
      assert.equal(receipt.status, "success");
      assert(receipt.contractAddress);
      const code = await rpc.getCode({ address: receipt.contractAddress });
      assert(code);
      assert.equal(
        normalizeRuntime(code, artifact.deployedBytecode),
        normalizeRuntime(
          artifact.deployedBytecode.object,
          artifact.deployedBytecode,
        ),
      );
      const abi = parseAbi([
        "function owner() view returns(address)",
        "function paused() view returns(bool)",
        "function universalRouter() view returns(address)",
        "function permit2() view returns(address)",
        "function aqua0Hook() view returns(address)",
        "function extendedV4Encoding() view returns(bool)",
      ]);
      const values = await Promise.all(
        (
          [
            "owner",
            "paused",
            "universalRouter",
            "permit2",
            "aqua0Hook",
            "extendedV4Encoding",
          ] as const
        ).map((functionName) =>
          rpc.readContract({
            address: receipt.contractAddress!,
            abi,
            functionName,
          }),
        ),
      );
      assert.deepEqual(values, [
        getAddress(synthetic.address),
        true,
        ...bindings.map((value) => getAddress(value)),
        false,
      ]);
      await assert.rejects(() => signer.signTransaction(tx), /already/);
      assert.equal(kms.digests.length, 1);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          sleep(2000),
        ]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
  },
);
