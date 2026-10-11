import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeFunctionData, erc20Abi, getAddress, type Address } from "viem";
import {
  MONAD_HARD_CAPS,
  buildWorkerConfig,
  checkWorkerConfig,
  confirmationPhrase,
  monadFundingPlan,
  monadOwnerAbi,
  monadPolicySchema,
  monadSetupSteps,
  observeCopy,
  poolKey,
  poolKeyId,
  resolveLimits,
  windowCloseSteps,
  windowDeadline,
  windowOpenSteps,
  type MonadState,
} from "../src/owner-monad.js";
import { loadChains } from "../src/config.js";
import { assertFreeMonadRpc } from "../src/owner-tx.js";

const raw = JSON.parse(readFileSync("config/monad-owner-pilot.json", "utf8"));
const policy = monadPolicySchema.parse(raw);
const executor = getAddress("0x00000000000000000000000000000000000000e1");
const registry = loadChains().find((c) => c.chainId === 143);
function state(over: Partial<MonadState> = {}): MonadState {
  return {
    blockNumber: 1n,
    timestamp: 1_800_000_000n,
    gasPrice: 102_000_000_000n,
    baseFee: 100_000_000_000n,
    executor,
    executorCodeHash: "0x00",
    owner: policy.owner,
    paused: true,
    activeUntil: 0n,
    maxGasPrice: 0n,
    operator: false,
    maxInput: 0n,
    minProfit: 0n,
    aquaPools: { "usdc-usdt0": false, "usdc-weth": false },
    v3Pools: { "usdc-usdt0": false, "usdc-weth": false },
    ownerNative: 10n ** 20n,
    ownerBase: 0n,
    executorBase: 0n,
    ownerNonce: 0,
    ...over,
  };
}
const decode = (data: `0x${string}`) =>
  decodeFunctionData({ abi: monadOwnerAbi, data });

test("Monad policy parses and cannot exceed code-level ceilings or target another chain", () => {
  assert.equal(policy.chainId, 143);
  assert.deepEqual(policy.defaults.pools, ["usdc-usdt0"]);
  for (const mutation of [
    { chainId: 42161 },
    { extendedV4Encoding: true },
    { unexpected: 1 },
    {
      budgets: {
        ...raw.budgets,
        maxDeployFeeWei: (MONAD_HARD_CAPS.maxDeployFeeWei + 1n).toString(),
      },
    },
    { budgets: { ...raw.budgets, maxWorkerGasUnits: "2000001" } },
    { budgets: { ...raw.budgets, ownerMaxFeePerGasWei: "500000000001" } },
    { window: { ...raw.window, maxMinutes: 61 } },
  ])
    assert.equal(
      monadPolicySchema.safeParse({ ...raw, ...mutation }).success,
      false,
      JSON.stringify(mutation),
    );
});

test("the allowlisted pool id equals the live Uniswap V4 PoolId in the worker registry", () => {
  const pool = policy.pools.find((p) => p.label === "usdc-usdt0")!;
  const id = poolKeyId(poolKey(policy, pool));
  assert.equal(
    id,
    "0x26d1028fae5935b2553bcd7299884fb2150e9f5b135059fe49b9b8222aa3daad",
  );
  assert(registry?.pools.some((p) => p.poolId === id));
});

test("limit flags have conservative defaults and hard caps", () => {
  const d = resolveLimits(policy, {});
  assert.equal(d.maxInput, 5_000_000n);
  assert.equal(d.minProfit, 1_000n);
  assert.equal(d.fundTarget, 5_000_000n);
  assert.equal(d.maxGasPrice, 200_000_000_000n);
  assert.deepEqual(
    d.pools.map((p) => p.label),
    ["usdc-usdt0"],
  );
  for (const flags of [
    { maxInputUsdc: "20.000001" },
    { maxInputUsdc: "0" },
    { minProfitUsdc: "5" },
    { minProfitUsdc: "0.0000001" },
    { fundUsdc: "21" },
    { maxGasGwei: "101" },
    { maxGasGwei: "501" },
    { pools: "usdc-dai" },
    { pools: "usdc-usdt0,usdc-usdt0" },
    { maxInputUsdc: "1e3" },
  ])
    assert.throws(() => resolveLimits(policy, flags), JSON.stringify(flags));
  assert.equal(
    resolveLimits(policy, { pools: "usdc-usdt0,usdc-weth" }).pools.length,
    2,
  );
});

test("setup grants only operator, limits, gas cap and the chosen pools, and never unpauses", () => {
  const limits = resolveLimits(policy, {});
  const steps = monadSetupSteps(policy, state(), limits);
  assert.deepEqual(
    steps.map((s) => decode(s.data).functionName),
    [
      "setOperator",
      "setLimits",
      "setGasPriceLimit",
      "setAquaPool",
      "setV3Pool",
    ],
  );
  assert(steps.every((s) => s.to === executor && s.value === 0n));
  assert.deepEqual(decode(steps[0]!.data).args, [policy.owner, true]);
  assert.deepEqual(decode(steps[1]!.data).args, [
    policy.baseToken,
    5_000_000n,
    1_000n,
  ]);
  const key = decode(steps[3]!.data).args![0] as {
    hooks: Address;
    fee: number;
    tickSpacing: number;
  };
  assert.equal(key.hooks, policy.aqua0Hook);
  assert.equal(key.fee, 100);
  assert.equal(key.tickSpacing, 1);
  assert.deepEqual(decode(steps[4]!.data).args, [
    getAddress("0xacf82ECC826A9fc2D8c8C4d370d2D268fA5B3500"),
    true,
  ]);
  const configured = state({
    operator: true,
    maxInput: 5_000_000n,
    minProfit: 1_000n,
    maxGasPrice: 200_000_000_000n,
    aquaPools: { "usdc-usdt0": true, "usdc-weth": false },
    v3Pools: { "usdc-usdt0": true, "usdc-weth": false },
  });
  assert.deepEqual(monadSetupSteps(policy, configured, limits), []);
  // A live executor found during setup is turned OFF first; setup never emits setPaused(false).
  const live = monadSetupSteps(
    policy,
    { ...configured, paused: false, activeUntil: 99n },
    limits,
  );
  assert.deepEqual(
    live.map((s) => [decode(s.data).functionName, decode(s.data).args]),
    [
      ["setPaused", [true]],
      ["setActiveUntil", [0n]],
    ],
  );
});

test("funding is a plain capped ERC20 transfer of only the missing amount, or exact instructions", () => {
  const limits = resolveLimits(policy, {});
  const plan = monadFundingPlan(
    policy,
    state({ ownerBase: 9_000_000n, executorBase: 2_000_000n }),
    limits,
  );
  assert.equal(plan.kind, "transfer");
  if (plan.kind !== "transfer") return;
  assert.equal(plan.step.to, policy.baseToken);
  assert.equal(plan.step.value, 0n);
  const call = decodeFunctionData({ abi: erc20Abi, data: plan.step.data });
  assert.equal(call.functionName, "transfer");
  assert.deepEqual(call.args, [executor, 3_000_000n]);
  assert.equal(
    monadFundingPlan(policy, state({ executorBase: 5_000_000n }), limits).kind,
    "none",
  );
  const short = monadFundingPlan(
    policy,
    state({ ownerBase: 1_000_000n }),
    limits,
  );
  assert.equal(short.kind, "insufficient");
  if (short.kind === "insufficient") {
    assert.match(short.instructions, /exactly 4 USDC/);
    assert.match(short.instructions, new RegExp(policy.baseToken));
    assert.match(short.instructions, new RegExp(policy.owner));
    assert.match(short.instructions, /chain 143/);
  }
});

test("window helpers cap minutes at 60, open with a bounded deadline and close pause-first", () => {
  assert.throws(() => windowDeadline(100n, 0, 90));
  assert.throws(() => windowDeadline(100n, 61, 90));
  assert.throws(() => windowDeadline(100n, 1.5, 90));
  assert.equal(windowDeadline(1000n, 10, 90), 1000n + 690n);
  const open = windowOpenSteps(executor, "run1", 2000n);
  assert.deepEqual(
    open.map((s) => [decode(s.data).functionName, decode(s.data).args]),
    [
      ["setActiveUntil", [2000n]],
      ["setPaused", [false]],
    ],
  );
  const close = windowCloseSteps(
    { executor, paused: false, activeUntil: 5n },
    "run1",
    1,
  );
  assert.deepEqual(
    close.map((s) => [decode(s.data).functionName, decode(s.data).args]),
    [
      ["setPaused", [true]],
      ["setActiveUntil", [0n]],
    ],
  );
  assert.deepEqual(
    windowCloseSteps({ executor, paused: true, activeUntil: 0n }, "run1", 1),
    [],
  );
  assert.equal(confirmationPhrase("run", 10), "RUN MONAD 10 MIN");
  assert.equal(confirmationPhrase("deploy"), "DEPLOY 143");
});

const template = JSON.parse(readFileSync("config/monad-v4-pilot.json", "utf8"));
const kms = {
  region: "us-east-1",
  keyId:
    "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012",
};
const configuredState = state({
  operator: true,
  maxInput: 5_000_000n,
  minProfit: 1_000n,
  maxGasPrice: 200_000_000_000n,
  aquaPools: { "usdc-usdt0": true, "usdc-weth": false },
  v3Pools: { "usdc-usdt0": true, "usdc-weth": false },
  executorBase: 5_000_000n,
});

test("runtime worker config fills the executor and KMS key, strips notes and clamps sizes", () => {
  const config = buildWorkerConfig(template, {
    executor,
    operator: policy.owner,
    mode: "execute",
    allowBroadcast: false,
    maxInput: 5_000_000n,
    signer: { kms },
  });
  assert.equal(config._template, undefined);
  assert.equal(config.execution["143"].executor, executor);
  assert.deepEqual(config.execution["143"].kms, kms);
  assert.equal(config.execution["143"].allowBroadcast, false);
  assert.equal(config.markets[0].maxInput, "5000000");
  assert.equal(
    template.execution["143"].executor,
    "0x0000000000000000000000000000000000000000",
  );
  assert.throws(() =>
    buildWorkerConfig(template, {
      executor,
      operator: policy.owner,
      mode: "observe",
      allowBroadcast: true,
      signer: { kms },
    }),
  );
  assert.throws(() =>
    buildWorkerConfig(
      {
        ...template,
        execution: { ...template.execution, "8453": template.execution["143"] },
      },
      {
        executor,
        operator: policy.owner,
        mode: "execute",
        allowBroadcast: false,
        signer: { kms },
      },
    ),
  );
  const observe = observeCopy({
    ...config,
    execution: { "143": { ...config.execution["143"], allowBroadcast: true } },
  });
  assert.equal(observe.mode, "observe");
  assert.equal(observe.execution["143"].allowBroadcast, false);
});

test("worker config sanity refuses mismatched executor, hook, caps, pools and missing budgets", () => {
  const base = buildWorkerConfig(template, {
    executor,
    operator: policy.owner,
    mode: "execute",
    allowBroadcast: true,
    maxInput: 5_000_000n,
    signer: { kms },
  });
  const ctx = {
    policy,
    state: configuredState,
    registry,
    mode: "execute" as const,
    workerRpcExplicit: false,
  };
  assert.deepEqual(checkWorkerConfig(base, ctx).errors, []);
  const clone = () => JSON.parse(JSON.stringify(base));
  const cases: [string, (c: any) => void, RegExp][] = [
    [
      "executor",
      (c) =>
        (c.execution["143"].executor =
          "0x00000000000000000000000000000000000000e2"),
      /executor differs/,
    ],
    [
      "broadcast",
      (c) => (c.execution["143"].allowBroadcast = false),
      /allowBroadcast/,
    ],
    ["budget", (c) => delete c.backendBudget, /backendBudget/],
    [
      "gas",
      (c) => (c.execution["143"].maxFeePerGas = "300000000000"),
      /gas-price ceiling/,
    ],
    [
      "units",
      (c) => (c.execution["143"].maxGasUnits = "1600000"),
      /maxGasUnits/,
    ],
    [
      "daily",
      (c) => (c.execution["143"].maxDailyGasWei = "20000000000000000000"),
      /maxDailyGasWei/,
    ],
    [
      "pool",
      (c) =>
        (c.execution["143"].externalPools = [
          "0x25EF1a210fF55BcEe9F8fee979aAFf6bD1bE5Bf1",
        ]),
      /not allowlisted/,
    ],
    ["size", (c) => (c.markets[0].maxInput = "15000000"), /maxInput exceeds/],
    ["profit", (c) => (c.markets[0].minNetProfit = "999"), /profit floor/],
    ["chain", (c) => (c.execution["8453"] = c.execution["143"]), /chain 143/],
  ];
  for (const [name, mutate, expected] of cases) {
    const c = clone();
    mutate(c);
    assert.match(checkWorkerConfig(c, ctx).errors.join("\n"), expected, name);
  }
  const otherHook = {
    ...registry!,
    aqua0Hook: getAddress("0x027f56E669FBB2337557baeE210dbf79b87EC0C8"),
  };
  assert.match(
    checkWorkerConfig(base, { ...ctx, registry: otherHook }).errors.join("\n"),
    /aqua0Hook/,
  );
  const paidDefault = {
    ...registry!,
    publicRpc: "https://monad-mainnet.core.chainstack.com/abc",
  };
  assert.match(
    checkWorkerConfig(base, { ...ctx, registry: paidDefault }).errors.join(
      "\n",
    ),
    /free Monad endpoint/,
  );
  assert.match(
    checkWorkerConfig(base, { ...ctx, state: undefined }).errors.join("\n"),
    /verified executor/,
  );
  const observeTemplate = JSON.parse(
    readFileSync("config/monad-v4-pilot.observe.json", "utf8"),
  );
  assert.deepEqual(
    checkWorkerConfig(observeTemplate, {
      ...ctx,
      mode: "observe",
      state: undefined,
    }).errors,
    [],
  );
});

test("RPC guard allows only free Monad endpoints or a loopback fork, never the paid env endpoint", () => {
  for (const ok of [
    "https://rpc2.monad.xyz",
    "https://rpc-mainnet.monadinfra.com",
    "http://127.0.0.1:8545",
  ])
    assert.equal(assertFreeMonadRpc(ok, {}), ok);
  for (const bad of [
    "https://monad-mainnet.core.chainstack.com/secret",
    "http://rpc2.monad.xyz",
    "https://rpc2.monad.xyz/some-token",
    "http://localhost:8545",
    "https://user:pw@rpc2.monad.xyz",
  ])
    assert.throws(() => assertFreeMonadRpc(bad, {}), bad);
  assert.throws(
    () =>
      assertFreeMonadRpc("https://rpc2.monad.xyz", {
        RPC_URL_MAINNET_MONAD: "https://rpc2.monad.xyz/",
      }),
    /paid/,
  );
});
