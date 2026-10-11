import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  keccak256,
  recoverTransactionAddress,
  serializeTransaction,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createOwnerCallAccount,
  createOwnerDeploymentAccount,
} from "../src/kms-account.js";
import {
  OwnerJournal,
  TEST_SIGNER_KEY_ID,
  acquireOwnerLock,
  anvilTestAccount,
  anvilTestTransport,
  assertAnvilTestTarget,
  ownerIdentity,
  reconcileRecord,
  sendOwnerCall,
  type OwnerIdentity,
  type SendContext,
  type TxRecord,
} from "../src/owner-tx.js";
import { mockKms, MOCK_KMS_KEY } from "./helpers/mock-kms.js";

const target = "0x00000000000000000000000000000000000000e1" as const;
const call = {
  type: "legacy" as const,
  chainId: 143,
  nonce: 0,
  to: target,
  data: "0x16c38b3c0000000000000000000000000000000000000000000000000000000000000001" as Hex,
  value: 0n,
  gas: 60_000n,
  gasPrice: 112_000_000_000n,
};

test("Monad owner calls are zero-value and within the signer gas-limit and fee budget", async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const kms = mockKms(wallet);
  const config = {
    keyId: MOCK_KMS_KEY,
    region: "us-east-1",
    address: wallet.address,
    chainId: 143,
    target,
  };
  for (const bad of [
    { ...call, value: 1n },
    { ...call, gas: 500_001n },
    { ...call, gas: 400_000n, gasPrice: 2_000_000_000_000n },
  ]) {
    const account = await createOwnerCallAccount(
      config,
      keccak256(serializeTransaction(bad)),
      kms.transport,
    );
    await assert.rejects(
      () => account.signTransaction(bad),
      /native value|budget/,
    );
  }
  assert.equal(kms.digests.length, 0);
  const account = await createOwnerCallAccount(
    config,
    keccak256(serializeTransaction(call)),
    kms.transport,
  );
  await assert.rejects(
    () => account.signTransaction({ ...call, chainId: 42161 }),
    /reviewed/,
  );
  const raw = await account.signTransaction(call);
  assert.equal(
    await recoverTransactionAddress({
      serializedTransaction: raw as TransactionSerialized,
    }),
    wallet.address,
  );
  await assert.rejects(() => account.signTransaction(call), /already used/);
  await assert.rejects(
    () =>
      createOwnerCallAccount(
        { ...config, chainId: 1 },
        keccak256(serializeTransaction(call)),
        kms.transport,
      ),
    /Arbitrum or Monad/,
  );
});

test("Monad creation is bounded by the signer gas-limit and maximum-fee budget", async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const kms = mockKms(wallet);
  const config = {
    keyId: MOCK_KMS_KEY,
    region: "us-east-1",
    address: wallet.address,
    chainId: 143,
  };
  const tx = {
    type: "eip1559" as const,
    chainId: 143,
    nonce: 0,
    gas: 3_700_000n,
    maxFeePerGas: 112_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
    value: 0n,
    data: "0x60006000f3" as Hex,
  };
  for (const bad of [
    { ...tx, gas: 6_000_001n },
    { ...tx, maxFeePerGas: 600_000_000_000n },
  ]) {
    const account = await createOwnerDeploymentAccount(
      config,
      keccak256(serializeTransaction(bad)),
      kms.transport,
    );
    await assert.rejects(() => account.signTransaction(bad), /budget/);
  }
  const account = await createOwnerDeploymentAccount(
    config,
    keccak256(serializeTransaction(tx)),
    kms.transport,
  );
  await assert.rejects(
    () => account.signTransaction({ ...tx, chainId: 42161 }),
    /Arbitrum or Monad/,
  );
  assert.equal(
    await account.signTransaction(tx),
    await wallet.signTransaction(tx),
  );
  assert.equal(kms.digests.length, 1);
});

test("the anvil-test signer reuses the one-use KMS signer path and refuses non-loopback RPCs", async () => {
  const transport = anvilTestTransport();
  const address = anvilTestAccount().address;
  assert.equal(address, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  const account = await createOwnerCallAccount(
    {
      keyId: TEST_SIGNER_KEY_ID,
      region: "us-east-1",
      address,
      chainId: 143,
      target,
    },
    keccak256(serializeTransaction(call)),
    transport,
  );
  const raw = await account.signTransaction(call);
  assert.equal(
    await recoverTransactionAddress({
      serializedTransaction: raw as TransactionSerialized,
    }),
    address,
  );
  const never = {
    request: async () => assert.fail("must not contact a non-loopback RPC"),
  } as never;
  for (const url of [
    "https://rpc2.monad.xyz",
    "http://localhost:8545",
    "http://10.0.0.2:8545",
  ])
    await assert.rejects(
      () => assertAnvilTestTarget(never, url),
      /127\.0\.0\.1/,
    );
  const notAnvil = { request: async () => "geth/v1.14" } as never;
  await assert.rejects(
    () => assertAnvilTestTarget(notAnvil, "http://127.0.0.1:8545"),
    /anvil/,
  );
  await assert.rejects(
    () => ownerIdentity("anvil-test", never, "https://rpc2.monad.xyz", address),
    /127\.0\.0\.1/,
  );
});

test("KMS owner identity needs the dedicated env names and the reviewed owner, without echoing values", async () => {
  const secret =
    "arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-1234-1234-1234-123456789012";
  const owner = "0xd1fC4c8631E8C5d23a0C86D5890802DD70Cb4cf5" as const;
  const client = {} as never;
  await assert.rejects(
    () => ownerIdentity("kms", client, "https://rpc2.monad.xyz", owner, {}),
    /not loaded/,
  );
  await assert.rejects(
    () =>
      ownerIdentity("kms", client, "https://rpc2.monad.xyz", owner, {
        AWS_REGION: "us-east-1",
        MARKET_REBALANCER_KMS_KEY_ID: secret,
        MARKET_REBALANCER_OPERATOR_ADDRESS:
          "0x1111111111111111111111111111111111111111",
      }),
    (e) =>
      e instanceof Error &&
      /reviewed owner/.test(e.message) &&
      !e.message.includes(secret),
  );
});

test("owner journal and lock are private, scoped, and a dead holder's lock is reclaimed", () => {
  const dir = mkdtempSync(join(tmpdir(), "monad-owner-"));
  try {
    const state = join(dir, "state");
    mkdirSync(state, { mode: 0o755 });
    chmodSync(state, 0o755);
    const identity = {
      chainId: 143,
      owner: "0xd1fC4c8631E8C5d23a0C86D5890802DD70Cb4cf5" as const,
      scope: "s",
    };
    const journal = new OwnerJournal(join(state, "j.json"), identity);
    journal.save();
    assert.equal(lstatSync(state).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(state, "j.json")).mode & 0o777, 0o600);
    assert.throws(
      () =>
        new OwnerJournal(join(state, "j.json"), {
          ...identity,
          scope: "other",
        }),
      /scope/,
    );
    assert.throws(
      () =>
        new OwnerJournal(join(state, "j.json"), {
          ...identity,
          chainId: 42161,
        }),
      /chain/,
    );
    const lock = join(state, "owner.lock");
    const dead = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid))"],
      { encoding: "utf8" },
    );
    writeFileSync(lock, dead.stdout, { mode: 0o600 });
    const release = acquireOwnerLock(lock);
    assert.throws(() => acquireOwnerLock(lock), /holds/);
    release();
    acquireOwnerLock(lock)();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeContext(
  journal: OwnerJournal,
  client: object,
  signs: Hex[],
  mode: "strict" | "close",
): SendContext {
  const identity: OwnerIdentity = {
    mode: "anvil-test",
    address: anvilTestAccount().address,
    keyId: TEST_SIGNER_KEY_ID,
    region: "us-east-1",
    transport: {
      publicKey: anvilTestTransport().publicKey,
      signDigest: async (keyId, digest) => {
        signs.push(`0x${Buffer.from(digest).toString("hex")}`);
        return anvilTestTransport().signDigest(keyId, digest);
      },
    },
  };
  return {
    client: client as never,
    journal,
    chainId: 143,
    identity,
    gas: {
      maxFeePerGas: 250_000_000_000n,
      priorityFeeWei: 2_000_000_000n,
      priceMarginBps: 11000n,
      gasMarginBps: 12000n,
      maxGas: 300_000n,
    },
    allowedTargets: [target],
    mode,
  };
}

test("journaled sends refuse out-of-scope targets, MON value and excessive gas before any signature", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monad-owner-"));
  try {
    const journal = new OwnerJournal(join(dir, "s", "j.json"), {
      chainId: 143,
      owner: anvilTestAccount().address,
      scope: "t",
    });
    const signs: Hex[] = [];
    const client = {
      getChainId: async () => 143,
      getTransactionCount: async () => 0,
      getGasPrice: async () => 400_000_000_000n,
      getBlock: async () => ({ baseFeePerGas: 100_000_000_000n }),
      estimateGas: async () => 50_000n,
      getBalance: async () => 10n ** 21n,
    };
    const ctx = fakeContext(journal, client, signs, "strict");
    const step = {
      id: "x",
      description: "x",
      to: target,
      data: call.data,
      value: 0n,
    };
    await assert.rejects(
      () =>
        sendOwnerCall(ctx, {
          ...step,
          to: "0x00000000000000000000000000000000000000e2",
        }),
      /scope/,
    );
    await assert.rejects(
      () => sendOwnerCall(ctx, { ...step, value: 1n }),
      /never send MON/,
    );
    await assert.rejects(() => sendOwnerCall(ctx, step), /ceiling/);
    assert.equal(signs.length, 0);
    assert.equal(journal.data.records.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the safety close abandons only never-broadcast or unaccepted non-close intents; strict mode stops", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monad-owner-"));
  try {
    const journal = new OwnerJournal(join(dir, "s", "j.json"), {
      chainId: 143,
      owner: anvilTestAccount().address,
      scope: "t",
    });
    const record = (id: string, extra: Partial<TxRecord> = {}): TxRecord => ({
      id,
      description: id,
      kind: "call",
      to: target,
      data: call.data,
      value: "0",
      nonce: 5,
      gas: "60000",
      gasPrice: "112000000000",
      unsignedHash: `0x${"1".repeat(64)}`,
      phase: "prepared",
      createdAt: new Date().toISOString(),
      ...extra,
    });
    const unknown = {
      getTransactionReceipt: async () => {
        throw new Error("not found");
      },
      getTransaction: async () => {
        throw new Error("not found");
      },
      getTransactionCount: async () => 5,
      sendRawTransaction: async () =>
        assert.fail("must not rebroadcast a non-close intent"),
    };
    const signs: Hex[] = [];
    const strict = fakeContext(journal, unknown, signs, "strict");
    const close = fakeContext(journal, unknown, signs, "close");
    const hashless = record("setup:x");
    journal.data.records.push(hashless);
    await assert.rejects(
      () => reconcileRecord(strict, hashless),
      /no saved transaction hash/,
    );
    assert.equal((await reconcileRecord(close, hashless)).phase, "abandoned");
    const open = record("open:r:unpause", {
      phase: "signed",
      hash: `0x${"2".repeat(64)}`,
      raw: "0x01",
    });
    journal.data.records.push(open);
    assert.equal((await reconcileRecord(close, open)).phase, "abandoned");
    const consumed = record("close:r:pause:1", {
      phase: "broadcast",
      hash: `0x${"3".repeat(64)}`,
      raw: "0x01",
    });
    journal.data.records.push(consumed);
    const later = { ...unknown, getTransactionCount: async () => 6 };
    assert.equal(
      (
        await reconcileRecord(
          fakeContext(journal, later, signs, "close"),
          consumed,
        )
      ).phase,
      "superseded",
    );
    assert.equal(signs.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "Monad owner Python guards pass their unit tests",
  { timeout: 120000 },
  () => {
    for (const pattern of [
      "test_owner_timed_run_monad.py",
      "test_owner_monad_wrappers.py",
    ]) {
      const result = spawnSync(
        "python3",
        ["-m", "unittest", "discover", "-s", "ops", "-p", pattern],
        {
          encoding: "utf8",
          timeout: 110000,
        },
      );
      assert.equal(
        result.status,
        0,
        `${pattern}\n${result.stdout}\n${result.stderr}`,
      );
    }
  },
);
