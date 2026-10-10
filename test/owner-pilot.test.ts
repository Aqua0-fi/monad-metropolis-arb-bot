import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decodeFunctionData, type PublicClient, type Hex } from "viem";
import { readAwsSessionFile } from "../src/aws-session-file.js";
import {
  pilotPolicySchema,
  setupSteps,
  fundingStep,
  unpauseStep,
  pilotExecutionConfig,
  ownerSetupAbi,
  fundingAbi,
  type PilotState,
} from "../src/owner-pilot.js";
const raw = JSON.parse(readFileSync("config/arbitrum-pilot.json", "utf8"));
const p = pilotPolicySchema.parse(raw);
const hash = `0x${"ab".repeat(32)}` as Hex;
const state: PilotState = {
  blockNumber: 100n,
  blockHash: hash,
  timestamp: 1000n,
  paused: true,
  operator: false,
  maxInput: 0n,
  minimumGrossProfit: 0n,
  gasPriceCap: 0n,
  poolAllowed: false,
  routerAllowed: false,
  strategyAllowed: false,
  inventory: 0n,
  ownerEth: 5_000_000_000_000_000n,
  externalFee: 500,
  currentOrder: hash,
  executorCodeHash: hash,
  makerCodeHash: hash,
};

test("owner setup only grants the intended operator, route and caps; already correct grants are not repeated", () => {
  const steps = setupSteps(p, state);
  const names = steps.map(
    (s) =>
      decodeFunctionData({ abi: ownerSetupAbi, data: s.data }).functionName,
  );
  assert.deepEqual(names, [
    "setOperator",
    "setLimits",
    "setGasPriceLimit",
    "setV3Pool",
    "setSwapVMRouter",
    "setSwapVMStrategy",
  ]);
  assert.ok(steps.every((s) => s.to === p.executor && s.value === 0n));
  const limits = decodeFunctionData({
    abi: ownerSetupAbi,
    data: steps[1]!.data,
  });
  assert.deepEqual(limits.args, [p.baseToken, 5_000_000n, 10_000n]);
  const route = decodeFunctionData({
    abi: ownerSetupAbi,
    data: steps[5]!.data,
  });
  assert.deepEqual(route.args, [p.swapVMRouter, p.maker, p.strategyId, true]);
  assert.deepEqual(
    setupSteps(p, {
      ...state,
      operator: true,
      maxInput: p.maxInput,
      minimumGrossProfit: p.minNetProfit,
      gasPriceCap: p.maxFeePerGas,
      poolAllowed: true,
      routerAllowed: true,
      strategyAllowed: true,
    }),
    [],
  );
  assert.equal(
    decodeFunctionData({ abi: ownerSetupAbi, data: unpauseStep(p).data })
      .functionName,
    "setPaused",
  );
  assert.equal(unpauseStep(p).value, 0n);
});

test("native funding uses actual pool fee, exact missing USDC output and a same-call ETH refund to sender", async () => {
  let calls = 0;
  const client = {
    simulateContract: async (r: any) => {
      calls++;
      assert.equal(r.functionName, "quoteExactOutputSingle");
      assert.equal(r.args[0].fee, 500);
      assert.equal(r.args[0].amount, 3_000_000n);
      assert.equal(r.blockNumber, 100n);
      return { result: [1_000_000_000_000_001n, 0n, 0, 0n] };
    },
  } as unknown as PublicClient;
  const step = await fundingStep(client, p, {
    ...state,
    inventory: 2_000_000n,
  });
  assert(step);
  assert.equal(step.to, p.fundingRouter);
  assert.equal(step.value, 1_010_000_000_000_002n);
  const decoded = decodeFunctionData({ abi: fundingAbi, data: step.data });
  assert.equal(decoded.functionName, "multicall");
  const args = decoded.args as readonly [bigint, readonly Hex[]];
  assert.equal(args[0], 1180n);
  assert.equal(args[1].length, 2);
  const exact = decodeFunctionData({ abi: fundingAbi, data: args[1][0]! });
  assert.equal(exact.functionName, "exactOutputSingle");
  assert.deepEqual(exact.args, [
    {
      tokenIn: p.wrappedNative,
      tokenOut: p.baseToken,
      fee: 500,
      recipient: p.executor,
      amountOut: 3_000_000n,
      amountInMaximum: step.value,
      sqrtPriceLimitX96: 0n,
    },
  ]);
  assert.equal(
    decodeFunctionData({ abi: fundingAbi, data: args[1][1]! }).functionName,
    "refundETH",
  );
  assert.equal(
    await fundingStep(client, p, { ...state, inventory: 6_000_000n }),
    null,
  );
  assert.equal(
    calls,
    1,
    "Existing inventory and profits must not cause another funding purchase",
  );
  await assert.rejects(
    () =>
      fundingStep(client, p, {
        ...state,
        inventory: 2_000_000n,
        ownerEth: 100n,
      }),
    /budget/,
  );
});

test("pilot bounds cannot be increased or another chain enabled by changing a file field", () => {
  for (const mutation of [
    { chainId: 1 },
    { maxInput: "5000001" },
    { inventoryTarget: "5000001" },
    { maxDailyGasWei: "300000000000001" },
    { maxFeePerGas: "50000001" },
    { maxFundingEthWei: "3000000000000001" },
    { feeBufferBps: 12500 },
    { unexpected: true },
  ])
    assert.equal(
      pilotPolicySchema.safeParse({ ...raw, ...mutation }).success,
      false,
    );
  const execution = pilotExecutionConfig(
    p,
    { region: "us-east-1", keyId: "reviewed-key" },
    100,
  );
  assert.equal(execution.allowBroadcast, false);
  assert.deepEqual(execution.externalPools, [p.externalPool]);
  assert.equal(execution.liveFeeBufferBps, 10500);
  assert.equal(execution.operator, p.owner);
});

test("dedicated credential files support rotation and optional sessions, but reject exposure, links and expiry", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-credentials-test-"));
  const path = join(dir, "creds.json");
  const credential = {
    accessKeyId: "A".repeat(20),
    secretAccessKey: "x".repeat(40),
  };
  try {
    writeFileSync(path, JSON.stringify(credential), { mode: 0o600 });
    assert.deepEqual(readAwsSessionFile(path), credential);
    writeFileSync(
      path,
      JSON.stringify({ ...credential, secretAccessKey: "y".repeat(40) }),
    );
    assert.equal(readAwsSessionFile(path).secretAccessKey, "y".repeat(40));
    chmodSync(path, 0o644);
    assert.throws(() => readAwsSessionFile(path), /unsafe/);
    chmodSync(path, 0o600);
    const link = join(dir, "link");
    symlinkSync(path, link);
    assert.throws(() => readAwsSessionFile(link), /unsafe/);
    writeFileSync(
      path,
      JSON.stringify({
        ...credential,
        sessionToken: "z".repeat(32),
        expiration: "2000-01-01T00:00:00Z",
      }),
    );
    assert.throws(() => readAwsSessionFile(path), /expired/);
    writeFileSync(
      path,
      JSON.stringify({ ...credential, extra: "never echo this value" }),
    );
    assert.throws(
      () => readAwsSessionFile(path),
      (e) => e instanceof Error && !e.message.includes("never echo this value"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the one-command owner wrapper refuses non-interactive enablement before credentials, RPCs or host writes", () => {
  const result = spawnSync(
    "python3",
    ["ops/owner-start-arbitrum.py", "--enable"],
    { encoding: "utf8", timeout: 5000, stdio: "pipe" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /interactive terminal/);
  assert.doesNotMatch(result.stdout, /transactionHash|runtimeSignerVerified/);
});
