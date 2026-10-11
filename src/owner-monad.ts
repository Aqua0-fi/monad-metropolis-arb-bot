import { z } from "zod";
import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  parseAbi,
  parseUnits,
  formatUnits,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  address,
  positive,
  same,
  settingsSchema,
  type ChainConfig,
} from "./config.js";
import { normalizeRuntime, type RuntimeArtifact } from "./owner-deployment.js";
import {
  OwnerSafetyError,
  FREE_MONAD_RPC_HOSTS,
  type OwnerCallStep,
} from "./owner-tx.js";

export const MONAD_CHAIN_ID = 143;
/** Code-level ceilings. A policy file or flag can only choose values at or below these. */
export const MONAD_HARD_CAPS = {
  maxInputRaw: 20_000_000n, // 20 USDC
  fundRaw: 20_000_000n, // 20 USDC
  minMaxGasPriceWei: 102_000_000_000n, // Monad base-fee floor (100 gwei) + typical 2 gwei tip
  maxGasPriceWei: 500_000_000_000n, // 500 gwei
  maxDeployFeeWei: 2_000_000_000_000_000_000n, // 2 MON
  maxSetupFeeWei: 1_000_000_000_000_000_000n, // 1 MON
  maxWindowFeeWei: 500_000_000_000_000_000n, // 0.5 MON per open
  maxWorkerDailyGasWei: 20_000_000_000_000_000_000n, // 20 MON
  maxWorkerGasUnits: 2_000_000n,
  maxMinutes: 60,
};

const poolEntry = z
  .object({
    label: z.string().regex(/^[a-z0-9-]+$/),
    currency0: address,
    currency1: address,
    fee: z.number().int().min(1).max(1_000_000),
    tickSpacing: z.number().int().min(1).max(32767),
    externalPool: address,
    externalFee: z.number().int().min(1).max(1_000_000),
  })
  .strict();
export const monadPolicySchema = z
  .object({
    chainId: z.literal(143),
    owner: address,
    baseToken: address,
    baseSymbol: z.literal("USDC"),
    baseDecimals: z.literal(6),
    wrappedNative: address,
    gasConversionFee: z.number().int().positive(),
    poolManager: address,
    universalRouter: address,
    permit2: address,
    aqua0Hook: address,
    extendedV4Encoding: z.literal(false),
    v3Factory: address,
    v3Quoter: address,
    pools: z.array(poolEntry).min(1).max(4),
    defaults: z
      .object({
        maxInputUsdc: z.string(),
        minProfitUsdc: z.string(),
        fundUsdc: z.string(),
        maxGasPriceGwei: z.string(),
        pools: z.array(z.string()).min(1),
      })
      .strict(),
    budgets: z
      .object({
        deployGasMarginBps: z.number().int().min(10000).max(13000),
        maxDeployFeeWei: positive,
        ownerMaxFeePerGasWei: positive,
        emergencyMaxFeePerGasWei: positive,
        priorityFeeWei: positive,
        priceMarginBps: z.number().int().min(10000).max(15000),
        ownerCallGasMarginBps: z.number().int().min(10000).max(15000),
        maxOwnerCallGas: positive,
        maxSetupFeeWei: positive,
        maxWindowFeeWei: positive,
        ownerReserveWei: positive,
        maxWorkerDailyGasWei: positive,
        maxWorkerGasUnits: positive,
      })
      .strict(),
    window: z
      .object({
        maxMinutes: z.number().int().min(1).max(60),
        graceSeconds: z.number().int().min(15).max(300),
        killSlackSeconds: z.number().int().min(5).max(120),
      })
      .strict(),
    note: z.string(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const b = p.budgets;
    if (
      b.maxDeployFeeWei > MONAD_HARD_CAPS.maxDeployFeeWei ||
      b.maxSetupFeeWei > MONAD_HARD_CAPS.maxSetupFeeWei ||
      b.maxWindowFeeWei > MONAD_HARD_CAPS.maxWindowFeeWei ||
      b.ownerMaxFeePerGasWei > MONAD_HARD_CAPS.maxGasPriceWei ||
      b.emergencyMaxFeePerGasWei > 2_000_000_000_000n ||
      b.emergencyMaxFeePerGasWei < b.ownerMaxFeePerGasWei ||
      b.maxOwnerCallGas > 500_000n ||
      b.maxWorkerDailyGasWei > MONAD_HARD_CAPS.maxWorkerDailyGasWei ||
      b.maxWorkerGasUnits > MONAD_HARD_CAPS.maxWorkerGasUnits
    )
      ctx.addIssue({
        code: "custom",
        message: "Monad owner policy exceeds its code-level budget ceilings",
      });
    for (const pool of p.pools) {
      if (
        BigInt(pool.currency0) >= BigInt(pool.currency1) ||
        (!same(pool.currency0, p.baseToken) &&
          !same(pool.currency1, p.baseToken))
      )
        ctx.addIssue({
          code: "custom",
          message: `Pool ${pool.label} must be sorted and contain the base token`,
        });
    }
    if (new Set(p.pools.map((x) => x.label)).size !== p.pools.length)
      ctx.addIssue({ code: "custom", message: "Duplicate pool label" });
  });
export type MonadPolicy = z.infer<typeof monadPolicySchema>;
export type MonadPool = MonadPolicy["pools"][number];

export const monadOwnerAbi = parseAbi([
  "function owner() view returns(address)",
  "function paused() view returns(bool)",
  "function activeUntil() view returns(uint64)",
  "function maxGasPrice() view returns(uint256)",
  "function operators(address) view returns(bool)",
  "function limits(address) view returns(uint256 maxInput,uint256 minProfit)",
  "function aquaPools(bytes32) view returns(bool)",
  "function v3Pools(address) view returns(address token0,address token1,bool allowed)",
  "function universalRouter() view returns(address)",
  "function permit2() view returns(address)",
  "function aqua0Hook() view returns(address)",
  "function extendedV4Encoding() view returns(bool)",
  "function setOperator(address,bool)",
  "function setLimits(address,uint256,uint256)",
  "function setGasPriceLimit(uint256)",
  "function setPaused(bool)",
  "function setActiveUntil(uint64)",
  "function setAquaPool((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),bool)",
  "function setV3Pool(address,bool)",
  "event Executed(bytes32 indexed id,address indexed token,uint256 input,uint256 profit)",
]);
const v3IdentityAbi = parseAbi([
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function fee() view returns(uint24)",
  "function factory() view returns(address)",
  "function getPool(address,address,uint24) view returns(address)",
  "function poolManager() view returns(address)",
]);

export function poolKey(policy: MonadPolicy, pool: MonadPool) {
  return {
    currency0: pool.currency0,
    currency1: pool.currency1,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: policy.aqua0Hook,
  };
}
/** Executor allowlist id; equal to the Uniswap V4 PoolId. */
export function poolKeyId(key: ReturnType<typeof poolKey>): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

export interface MonadLimits {
  maxInput: bigint;
  minProfit: bigint;
  fundTarget: bigint;
  maxGasPrice: bigint;
  pools: MonadPool[];
}
function decimalUnits(text: string, decimals: number, label: string) {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text))
    throw new OwnerSafetyError(`${label} must be a plain decimal number`);
  const [, fraction = ""] = text.split(".");
  if (fraction.length > decimals)
    throw new OwnerSafetyError(`${label} has more than ${decimals} decimals`);
  return parseUnits(text, decimals);
}
/** Flags choose conservative values; code caps cannot be exceeded. */
export function resolveLimits(
  policy: MonadPolicy,
  flags: {
    maxInputUsdc?: string | undefined;
    minProfitUsdc?: string | undefined;
    fundUsdc?: string | undefined;
    maxGasGwei?: string | undefined;
    pools?: string | undefined;
  },
): MonadLimits {
  const d = policy.defaults;
  const maxInput = decimalUnits(
    flags.maxInputUsdc ?? d.maxInputUsdc,
    6,
    "--max-input-usdc",
  );
  const minProfit = decimalUnits(
    flags.minProfitUsdc ?? d.minProfitUsdc,
    6,
    "--min-profit-usdc",
  );
  const fundTarget = decimalUnits(
    flags.fundUsdc ?? d.fundUsdc,
    6,
    "--fund-usdc",
  );
  const maxGasPrice = decimalUnits(
    flags.maxGasGwei ?? d.maxGasPriceGwei,
    9,
    "--max-gas-gwei",
  );
  if (maxInput <= 0n || maxInput > MONAD_HARD_CAPS.maxInputRaw)
    throw new OwnerSafetyError(
      "--max-input-usdc must be > 0 and at most 20 USDC",
    );
  if (minProfit <= 0n || minProfit >= maxInput)
    throw new OwnerSafetyError(
      "--min-profit-usdc must be > 0 and below the max input",
    );
  if (fundTarget > MONAD_HARD_CAPS.fundRaw || fundTarget > maxInput * 4n)
    throw new OwnerSafetyError(
      "--fund-usdc is capped at 20 USDC and 4x the max input",
    );
  if (
    maxGasPrice < MONAD_HARD_CAPS.minMaxGasPriceWei ||
    maxGasPrice > MONAD_HARD_CAPS.maxGasPriceWei
  )
    throw new OwnerSafetyError(
      "--max-gas-gwei must be between 102 (Monad's 100 gwei floor + tip) and 500",
    );
  const labels = (flags.pools ?? d.pools.join(","))
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (labels.length === 0 || new Set(labels).size !== labels.length)
    throw new OwnerSafetyError("--pools must list distinct pool labels");
  const pools = labels.map((label) => {
    const pool = policy.pools.find((p) => p.label === label);
    if (!pool)
      throw new OwnerSafetyError(
        `Unknown pool ${label}; choose from ${policy.pools.map((p) => p.label).join(", ")}`,
      );
    return pool;
  });
  return { maxInput, minProfit, fundTarget, maxGasPrice, pools };
}

export interface MonadState {
  blockNumber: bigint;
  timestamp: bigint;
  gasPrice: bigint;
  baseFee: bigint;
  executor: Address;
  executorCodeHash: Hex;
  owner: Address;
  paused: boolean;
  activeUntil: bigint;
  maxGasPrice: bigint;
  operator: boolean;
  maxInput: bigint;
  minProfit: bigint;
  aquaPools: Record<string, boolean>;
  v3Pools: Record<string, boolean>;
  ownerNative: bigint;
  ownerBase: bigint;
  executorBase: bigint;
  ownerNonce: number;
}

/** Reads and verifies every binding at one block. Never repairs an incompatible existing approval. */
export async function readMonadState(
  client: PublicClient,
  policy: MonadPolicy,
  executor: Address,
  owner: Address,
  artifact: { deployedBytecode: RuntimeArtifact },
): Promise<MonadState> {
  if ((await client.getChainId()) !== MONAD_CHAIN_ID)
    throw new OwnerSafetyError("RPC is not Monad mainnet (chain 143)");
  const block = await client.getBlock();
  const at = { blockNumber: block.number };
  const own = (functionName: string, args: readonly unknown[] = []) =>
    client.readContract({
      address: executor,
      abi: monadOwnerAbi as Abi,
      functionName,
      args,
      ...at,
    }) as Promise<any>;
  const [
    code,
    onchainOwner,
    paused,
    activeUntil,
    maxGasPrice,
    operator,
    limits,
    router,
    permit2,
    hook,
    extended,
    ownerNative,
    ownerBase,
    executorBase,
    ownerNonce,
    gasPrice,
    decimals,
  ] = await Promise.all([
    client.getCode({ address: executor, ...at }),
    own("owner"),
    own("paused"),
    own("activeUntil"),
    own("maxGasPrice"),
    own("operators", [owner]),
    own("limits", [policy.baseToken]),
    own("universalRouter"),
    own("permit2"),
    own("aqua0Hook"),
    own("extendedV4Encoding"),
    client.getBalance({ address: owner, ...at }),
    client.readContract({
      address: policy.baseToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
      ...at,
    }),
    client.readContract({
      address: policy.baseToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [executor],
      ...at,
    }),
    client.getTransactionCount({ address: owner, blockTag: "latest" }),
    client.getGasPrice(),
    client.readContract({
      address: policy.baseToken,
      abi: erc20Abi,
      functionName: "decimals",
      ...at,
    }),
  ]);
  if (
    !code ||
    code === "0x" ||
    normalizeRuntime(code, artifact.deployedBytecode) !==
      normalizeRuntime(
        artifact.deployedBytecode.object,
        artifact.deployedBytecode,
      )
  )
    throw new OwnerSafetyError(
      "Executor runtime differs from the reviewed compiler artifact",
    );
  if (
    !same(onchainOwner, owner) ||
    !same(router, policy.universalRouter) ||
    !same(permit2, policy.permit2) ||
    !same(hook, policy.aqua0Hook) ||
    extended !== policy.extendedV4Encoding
  )
    throw new OwnerSafetyError(
      "Executor owner or immutable bindings differ from the reviewed Monad policy",
    );
  if (decimals !== policy.baseDecimals)
    throw new OwnerSafetyError("Base token decimals differ from policy");
  const aquaPools: Record<string, boolean> = {};
  const v3Pools: Record<string, boolean> = {};
  for (const pool of policy.pools) {
    const id = poolKeyId(poolKey(policy, pool));
    aquaPools[pool.label] = Boolean(await own("aquaPools", [id]));
    const approval = await own("v3Pools", [pool.externalPool]);
    const allowed = Boolean(approval[2]);
    if (
      allowed &&
      (!same(approval[0], pool.currency0) || !same(approval[1], pool.currency1))
    )
      throw new OwnerSafetyError(
        `Existing external approval for ${pool.label} differs; refusing to overwrite it`,
      );
    v3Pools[pool.label] = allowed;
  }
  if (
    (await client.getBlock({ blockNumber: block.number })).hash !== block.hash
  )
    throw new OwnerSafetyError("Preflight block reorganized; rerun");
  return {
    blockNumber: block.number,
    timestamp: block.timestamp,
    gasPrice,
    baseFee: block.baseFeePerGas ?? 0n,
    executor,
    executorCodeHash: keccak256(code),
    owner: getAddress(onchainOwner),
    paused,
    activeUntil: BigInt(activeUntil),
    maxGasPrice,
    operator,
    maxInput: limits[0],
    minProfit: limits[1],
    aquaPools,
    v3Pools,
    ownerNative,
    ownerBase,
    executorBase,
    ownerNonce,
  };
}

/** Verify the reviewed V4 pools are initialized and the external pools are the real factory pools. */
export async function verifyMonadVenues(
  client: PublicClient,
  policy: MonadPolicy,
  pools: MonadPool[],
) {
  const [routerManager, quoterFactory] = await Promise.all([
    client.readContract({
      address: policy.universalRouter,
      abi: v3IdentityAbi,
      functionName: "poolManager",
    }),
    client.readContract({
      address: policy.v3Quoter,
      abi: v3IdentityAbi,
      functionName: "factory",
    }),
  ]);
  if (
    !same(routerManager, policy.poolManager) ||
    !same(quoterFactory, policy.v3Factory)
  )
    throw new OwnerSafetyError(
      "Router/PoolManager or quoter/factory identity mismatch",
    );
  const extsload = parseAbi([
    "function extsload(bytes32) view returns(bytes32)",
  ]);
  for (const pool of pools) {
    const id = poolKeyId(poolKey(policy, pool));
    const slot = keccak256(
      encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n]),
    );
    const slot0 = await client.readContract({
      address: policy.poolManager,
      abi: extsload,
      functionName: "extsload",
      args: [slot],
    });
    if (BigInt(slot0) === 0n)
      throw new OwnerSafetyError(
        `Aqua0 V4 pool ${pool.label} is not initialized`,
      );
    const [t0, t1, fee, factory, registered] = await Promise.all([
      client.readContract({
        address: pool.externalPool,
        abi: v3IdentityAbi,
        functionName: "token0",
      }),
      client.readContract({
        address: pool.externalPool,
        abi: v3IdentityAbi,
        functionName: "token1",
      }),
      client.readContract({
        address: pool.externalPool,
        abi: v3IdentityAbi,
        functionName: "fee",
      }),
      client.readContract({
        address: pool.externalPool,
        abi: v3IdentityAbi,
        functionName: "factory",
      }),
      client.readContract({
        address: policy.v3Factory,
        abi: v3IdentityAbi,
        functionName: "getPool",
        args: [pool.currency0, pool.currency1, pool.externalFee],
      }),
    ]);
    if (
      !same(t0, pool.currency0) ||
      !same(t1, pool.currency1) ||
      fee !== pool.externalFee ||
      !same(factory, policy.v3Factory) ||
      !same(registered, pool.externalPool)
    )
      throw new OwnerSafetyError(
        `External V3 pool for ${pool.label} is not the reviewed factory pool`,
      );
  }
}

function call(
  executor: Address,
  id: string,
  description: string,
  functionName: string,
  args: readonly unknown[],
): OwnerCallStep {
  return {
    id,
    description,
    to: executor,
    value: 0n,
    data: encodeFunctionData({ abi: monadOwnerAbi as Abi, functionName, args }),
  };
}

/** Idempotent setup: only what differs. Always ends paused with activeUntil = 0. */
export function monadSetupSteps(
  policy: MonadPolicy,
  state: MonadState,
  limits: MonadLimits,
): OwnerCallStep[] {
  const e = state.executor;
  const out: OwnerCallStep[] = [];
  if (!state.paused)
    out.push(call(e, "setup:pause", "Pause the executor", "setPaused", [true]));
  if (state.activeUntil !== 0n)
    out.push(
      call(
        e,
        "setup:active-until-zero",
        "Close the trading window (activeUntil = 0)",
        "setActiveUntil",
        [0n],
      ),
    );
  if (!state.operator)
    out.push(
      call(
        e,
        "setup:operator",
        `Allow the owner wallet ${state.owner} as operator`,
        "setOperator",
        [state.owner, true],
      ),
    );
  if (
    state.maxInput !== limits.maxInput ||
    state.minProfit !== limits.minProfit
  )
    out.push(
      call(
        e,
        `setup:limits:${limits.maxInput}:${limits.minProfit}`,
        `Limit USDC trades to ${formatUnits(limits.maxInput, 6)} input with a ${formatUnits(limits.minProfit, 6)} USDC profit floor`,
        "setLimits",
        [policy.baseToken, limits.maxInput, limits.minProfit],
      ),
    );
  if (state.maxGasPrice !== limits.maxGasPrice)
    out.push(
      call(
        e,
        `setup:gas-cap:${limits.maxGasPrice}`,
        `Set the executor gas-price ceiling to ${formatUnits(limits.maxGasPrice, 9)} gwei`,
        "setGasPriceLimit",
        [limits.maxGasPrice],
      ),
    );
  for (const pool of limits.pools) {
    if (!state.aquaPools[pool.label])
      out.push(
        call(
          e,
          `setup:aqua-pool:${pool.label}`,
          `Allowlist Aqua0 V4 pool ${pool.label} (fee ${pool.fee}, spacing ${pool.tickSpacing})`,
          "setAquaPool",
          [poolKey(policy, pool), true],
        ),
      );
    if (!state.v3Pools[pool.label])
      out.push(
        call(
          e,
          `setup:v3-pool:${pool.label}`,
          `Allowlist external V3 pool ${pool.externalPool} for ${pool.label}`,
          "setV3Pool",
          [pool.externalPool, true],
        ),
      );
  }
  return out;
}

export type FundingPlan =
  | { kind: "none"; executorBase: bigint }
  | { kind: "transfer"; amount: bigint; step: OwnerCallStep }
  | {
      kind: "insufficient";
      amount: bigint;
      ownerBase: bigint;
      instructions: string;
    };
/** Plain ERC20 transfer from the owner, only the missing amount up to the cap. */
export function monadFundingPlan(
  policy: MonadPolicy,
  state: MonadState,
  limits: MonadLimits,
): FundingPlan {
  if (state.executorBase >= limits.fundTarget)
    return { kind: "none", executorBase: state.executorBase };
  const amount = limits.fundTarget - state.executorBase;
  if (amount > MONAD_HARD_CAPS.fundRaw)
    throw new OwnerSafetyError("Funding exceeds the hard cap");
  if (state.ownerBase < amount) {
    const missing = amount - state.ownerBase;
    return {
      kind: "insufficient",
      amount,
      ownerBase: state.ownerBase,
      instructions: `Send exactly ${formatUnits(missing, 6)} USDC (token ${policy.baseToken}, 6 decimals) on Monad (chain 143) to the owner wallet ${state.owner}, then rerun setup with --enable. Setup will then transfer ${formatUnits(amount, 6)} USDC to the executor ${state.executor}. Do not send MON or any other token to the executor.`,
    };
  }
  return {
    kind: "transfer",
    amount,
    step: {
      id: `setup:fund:${state.executor}:${limits.fundTarget}`,
      description: `Transfer ${formatUnits(amount, 6)} USDC from the owner wallet to the executor (cap ${formatUnits(limits.fundTarget, 6)})`,
      to: policy.baseToken,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [state.executor, amount],
      }),
    },
  };
}

export function isOff(state: Pick<MonadState, "paused" | "activeUntil">) {
  return state.paused && state.activeUntil === 0n;
}
export function windowOpenSteps(
  executor: Address,
  runId: string,
  activeUntil: bigint,
): OwnerCallStep[] {
  return [
    call(
      executor,
      `open:${runId}:active-until`,
      `Open the trading window until ${new Date(Number(activeUntil) * 1000).toISOString()}`,
      "setActiveUntil",
      [activeUntil],
    ),
    call(
      executor,
      `open:${runId}:unpause`,
      "Unpause the executor",
      "setPaused",
      [false],
    ),
  ];
}
/** Pause first (immediate stop), then zero the window. Only what is still needed. */
export function windowCloseSteps(
  state: Pick<MonadState, "executor" | "paused" | "activeUntil">,
  runId: string,
  attempt: number,
): OwnerCallStep[] {
  const out: OwnerCallStep[] = [];
  if (!state.paused)
    out.push(
      call(
        state.executor,
        `close:${runId}:pause:${attempt}`,
        "Pause the executor",
        "setPaused",
        [true],
      ),
    );
  if (state.activeUntil !== 0n)
    out.push(
      call(
        state.executor,
        `close:${runId}:active-until-zero:${attempt}`,
        "Close the trading window (activeUntil = 0)",
        "setActiveUntil",
        [0n],
      ),
    );
  return out;
}
export function windowDeadline(
  blockTimestamp: bigint,
  minutes: number,
  graceSeconds: number,
): bigint {
  if (
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > MONAD_HARD_CAPS.maxMinutes
  )
    throw new OwnerSafetyError("--minutes must be an integer from 1 to 60");
  const value = blockTimestamp + BigInt(minutes * 60 + graceSeconds);
  if (value > blockTimestamp + 86_400n)
    throw new OwnerSafetyError("Window exceeds the contract's 1 day bound");
  return value;
}
export function confirmationPhrase(
  kind: "deploy" | "setup" | "run",
  minutes?: number,
) {
  if (kind === "deploy") return "DEPLOY 143";
  if (kind === "setup") return "SETUP MONAD 143";
  return `RUN MONAD ${minutes} MIN`;
}

// ---------------------------------------------------------------------------
// Worker configuration (runtime copy) and its sanity checks.
// ---------------------------------------------------------------------------
type Json = Record<string, any>;
/**
 * Runtime worker copy: template keys starting with "_" are notes and are stripped. Market sizes are clamped
 * to the executor's onchain maxInput so the worker never proposes a trade the contract must reject.
 */
export function buildWorkerConfig(
  template: Json,
  input: {
    executor: Address;
    operator: Address;
    mode: "observe" | "execute";
    allowBroadcast: boolean;
    maxInput?: bigint;
    signer:
      | { kms: { region: string; keyId: string } }
      | { privateKeyEnv: string };
  },
): Json {
  if (input.allowBroadcast && input.mode !== "execute")
    throw new OwnerSafetyError("allowBroadcast is only valid in execute mode");
  const copy: Json = JSON.parse(JSON.stringify(template));
  for (const key of Object.keys(copy))
    if (key.startsWith("_")) delete copy[key];
  const exec = copy.execution?.["143"];
  if (!exec || typeof exec !== "object")
    throw new OwnerSafetyError('Worker template has no execution["143"] block');
  if (Object.keys(copy.execution).some((k) => k !== "143"))
    throw new OwnerSafetyError(
      "Worker template configures execution on another chain",
    );
  exec.executor = input.executor;
  exec.operator = input.operator;
  delete exec.kms;
  delete exec.privateKeyEnv;
  Object.assign(exec, input.signer);
  copy.mode = input.mode;
  exec.allowBroadcast = input.allowBroadcast;
  if (input.maxInput !== undefined)
    for (const market of copy.markets ?? []) {
      if (BigInt(market.maxInput) > input.maxInput)
        market.maxInput = String(input.maxInput);
      if (Array.isArray(market.amounts))
        market.amounts = market.amounts.filter(
          (a: string) => BigInt(a) <= input.maxInput!,
        );
    }
  settingsSchema.parse(copy);
  return copy;
}
/** Observe-only copy of a runtime config: never broadcasts. */
export function observeCopy(config: Json): Json {
  const copy: Json = JSON.parse(JSON.stringify(config));
  copy.mode = "observe";
  if (copy.execution?.["143"]) copy.execution["143"].allowBroadcast = false;
  settingsSchema.parse(copy);
  return copy;
}

export interface WorkerConfigCheck {
  errors: string[];
  warnings: string[];
}
export function checkWorkerConfig(
  raw: Json,
  ctx: {
    policy: MonadPolicy;
    /** Undefined only for an observe run before any executor is deployed. */
    state: MonadState | undefined;
    registry: ChainConfig | undefined;
    mode: "observe" | "execute";
    workerRpcExplicit: boolean;
  },
): WorkerConfigCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  let settings;
  try {
    settings = settingsSchema.parse(raw);
  } catch {
    return {
      errors: ["Worker config does not match the worker settings schema"],
      warnings,
    };
  }
  const { policy, state, registry } = ctx;
  if (!state && ctx.mode === "execute")
    errors.push("Execute mode requires a verified executor");
  if (settings.mode !== ctx.mode)
    errors.push(`Worker mode is ${settings.mode}, expected ${ctx.mode}`);
  if (!raw.backendBudget || typeof raw.backendBudget !== "object")
    errors.push(
      "Worker config has no backendBudget block; refusing to run without a backend call budget",
    );
  const keys = Object.keys(settings.execution);
  if (keys.some((k) => k !== "143"))
    errors.push("Worker execution may only be configured for chain 143");
  if (ctx.mode === "execute" && !settings.execution["143"])
    errors.push('Worker config has no execution["143"] block');
  const allowed = (pool: string) => {
    const entry = policy.pools.find((p) => same(p.externalPool, pool));
    if (!entry) return `External pool ${pool} is not in the Monad policy`;
    if (state && !state.v3Pools[entry.label])
      return `External pool ${pool} is not allowlisted onchain`;
    return undefined;
  };
  const exec = settings.execution["143"];
  if (exec) {
    if ((ctx.mode === "execute") !== exec.allowBroadcast)
      errors.push(
        "Worker allowBroadcast must be true only for an execute window",
      );
    if (!same(exec.wrappedNative, policy.wrappedNative))
      errors.push("Worker wrappedNative is not WMON");
    if (exec.maxGasUnits > policy.budgets.maxWorkerGasUnits)
      errors.push(
        `Worker maxGasUnits exceeds ${policy.budgets.maxWorkerGasUnits} (Monad charges the full gas limit)`,
      );
    if (exec.maxDailyGasWei > policy.budgets.maxWorkerDailyGasWei)
      errors.push("Worker maxDailyGasWei exceeds the Monad policy ceiling");
    if (state) {
      if (!same(exec.executor, state.executor))
        errors.push("Worker executor differs from the verified executor");
      if (!same(exec.operator, state.owner))
        errors.push("Worker operator differs from the owner/operator wallet");
      if (exec.maxFeePerGas > state.maxGasPrice)
        errors.push(
          "Worker maxFeePerGas exceeds the executor's onchain gas-price ceiling",
        );
      if (exec.maxFeePerGas < state.baseFee)
        warnings.push(
          "Worker maxFeePerGas is below the current base fee; it cannot trade",
        );
    }
    for (const pool of exec.externalPools ?? []) {
      const issue = allowed(pool);
      if (issue) errors.push(issue);
    }
    if (!exec.externalPools?.length)
      errors.push("Worker externalPools must list the allowlisted V3 pools");
  }
  for (const market of settings.markets) {
    if (market.chainId !== 143) {
      errors.push(`Market ${market.poolId} is not on chain 143`);
      continue;
    }
    if (!same(market.baseToken, policy.baseToken))
      errors.push(`Market ${market.poolId} base token is not USDC`);
    const pool = policy.pools.find((p) =>
      same(poolKeyId(poolKey(policy, p)), market.poolId),
    );
    if (!pool)
      errors.push(`Market ${market.poolId} is not a reviewed Aqua0 pool`);
    if (state) {
      if (market.maxInput > state.maxInput)
        errors.push(
          `Market ${market.poolId} maxInput exceeds the onchain limit`,
        );
      if (market.minNetProfit < state.minProfit)
        errors.push(
          `Market ${market.poolId} minNetProfit is below the onchain profit floor`,
        );
      if (pool && !state.aquaPools[pool.label])
        errors.push(
          `Market ${market.poolId} (${pool.label}) is not allowlisted onchain`,
        );
    }
    if (registry && !registry.pools.some((p) => same(p.poolId, market.poolId)))
      errors.push(
        `Market ${market.poolId} is missing from the worker registry (config/chains.json)`,
      );
  }
  if (settings.markets.length === 0) {
    if (settings.discovery.enabled)
      warnings.push(
        "No explicit markets; the worker relies on discovery (only allowlisted pools can settle)",
      );
    else errors.push("Worker config has no markets");
  }
  if (!registry) errors.push("Worker registry has no chain 143 entry");
  else {
    if (!same(registry.aqua0Hook, policy.aqua0Hook))
      errors.push(
        `Worker registry Monad aqua0Hook ${registry.aqua0Hook} differs from the executor hook ${policy.aqua0Hook}`,
      );
    if (
      !same(registry.universalRouter, policy.universalRouter) ||
      !same(registry.permit2, policy.permit2)
    )
      errors.push(
        "Worker registry router/Permit2 differ from the executor bindings",
      );
    if (!ctx.workerRpcExplicit) {
      let host = "";
      try {
        host = new URL(registry.publicRpc ?? "").hostname;
      } catch {
        /* missing */
      }
      if (!FREE_MONAD_RPC_HOSTS.has(host))
        errors.push(
          "Worker default RPC (registry publicRpc) is not a known free Monad endpoint; pass --rpc",
        );
    }
  }
  for (const pool of settings.v4Search.externalPools["143"] ?? []) {
    const issue = allowed(pool);
    if (issue) errors.push(`v4Search: ${issue}`);
  }
  const ws = settings.scheduling.websocketEnv["143"];
  if (ws)
    warnings.push(
      `Worker websocketEnv[143]=${ws} is not passed to the child; it will poll over HTTP`,
    );
  return { errors, warnings };
}
