# Monad V4 fork verification (2026-10-12)

Local Foundry fork of Monad mainnet (chain 143) at block **112591595**, hash
`0xf1652ad0e40c48c46fcd277147ace69e28dd0e69653cb5bb1515929b0836f833` (timestamp 1791758826, base fee
100 gwei). The fork came from the public `https://rpc2.monad.xyz` endpoint. No transaction was signed or sent,
no key or KMS was used, and no Aqua0 backend endpoint was called. Foundry 1.5.1.

## Result

| Pair (local V4 key)        | External venue (real)              | Cases   | Evidence                                                                   |
| -------------------------- | ---------------------------------- | ------- | -------------------------------------------------------------------------- |
| USDC/USDT0 fee 100 / ts 1  | Uniswap V3 0.01% `0xacf82ECC…3500` | 10 / 10 | [report](../evidence/fork-143-112591595-venue0-fork-usdc-usdt0-monad.json) |
| USDC/WETH fee 3000 / ts 60 | Uniswap V3 0.3% `0x25EF1a21…5Bf1`  | 10 / 10 | [report](../evidence/fork-143-112591595-venue0-fork-usdc-weth-monad.json)  |

Reproduce with
`RPC_URL_MAINNET_MONAD=https://rpc2.monad.xyz python3 scripts/fork.py --chain 143 --block 112591595 --pair-fixture config/fork-usdc-usdt0-monad.json`
(or `fork-usdc-weth-monad.json`). Each JSON records the harness, executor-source and fixture SHA-256 hashes.

Each pair proves, with a 5 USDC start:

- `AquaThenExternalProfits` / `ExternalThenAquaProfits`: both route orders raise the USDC balance by the
  returned profit, vault accounting matches and approvals end at zero.
- `ImpossibleProfitRevertsBothLegsAndNonce`: `Unprofitable` reverts both legs. Executor, vault, PoolManager
  and V3 balances, the V3 price, the replay id and the signed JIT nonce are unchanged.
- `ClosedOrExpiredWindowRevertsBeforeAnySwap`: `setActiveUntil(0)` and a window that has expired (with a fresh
  trade deadline) both revert `Inactive`. A state-diff check shows the call touched no account other than the
  executor. The identical trade then succeeds once a window covers it.
- `SeparateOperatorTradesButCannotWithdrawOrReconfigure`: a non-owner operator executes a trade, then fails
  `withdraw` of either token, limit/gas/window/operator/pool changes and `transferOwnership`. It never holds
  tokens.
- `TradeAboveMaxInputRevertsBeforeAnySwap`: `maxInput = amount - 1` reverts `LimitExceeded` with nothing
  touched. The same trade passes exactly at the cap.
- `GasPriceAboveCapRevertsBeforeAnySwap`: `tx.gasprice = maxGasPrice + 1` reverts `GasPriceExceeded` with
  nothing touched. The trade passes exactly at the cap.
- `SecondLegCannotSpendPreexistingIntermediateBalance`: with 10x pre-existing USDT0/WETH in the executor, a
  second leg asking 1 wei more than the first leg delivered reverts `InsufficientOutput`. The executed Aqua0
  leg, its JIT settlement and nonce roll back.
- `UnlistedV3PoolRevertsAndRollsBackAquaLeg`: a real but never-allowlisted pool for the same pair
  (`0xa00D8Ec3…` / `0x6D47FB8f…`) and the delisted approved pool both revert `InvalidRoute` after the Aqua0
  leg ran. Everything rolls back.
- `UnlistedAquaPoolKeyRevertsAndRollsBackExternalLeg`: an unlisted fee tier, a foreign hook and the delisted
  key each revert `InvalidRoute` after the V3 leg ran. Everything rolls back.

Unit coverage of the same guards (outsider fuzzing, callbacks, reentrancy, SwapVM) stays in
`contracts/test/SecurityReview.t.sol` and `MarketRebalancer.t.sol`.

## Real versus seeded state

Real at the pinned block: USDC `0x7547…b603`, WETH `0xEE8c…1242`, USDT0 `0xe7cd…C82D`, the V3 pools,
PoolManager `0x188d…Ea8e`, UniversalRouter `0x0D97…9dc3` (legacy non-extended tuple, exercised) and Permit2.

Seeded or synthetic: the Aqua0 registry, both vaults (1,000,000 units of each token), the V4Adapter built from
vendored source at a local mined address, test signer and strategist keys, full-range JIT liquidity (1e11 /
1e15), executor capital (50 USDC via `deal`), and a local V4 pool initialised at the V3 sqrt price ×1.1 or ×0.9.
That is a price displacement of about +21% / -19%. The ~1.0–1.17 USDC profits on 5 USDC come from that seed.
They are not a profitability claim. The live hook `0xA2bd…68c0` was not called. Its bytecode was not compared
with the vendored source.

Observed live (read-only, same block): the live Aqua0 pools hold no in-range liquidity outside JIT swaps.
USDC/WETH sits at tick 197882 against V3 0.3% at tick 197970, a gap of about 0.88%. USDC/USDT0 sits at tick
-1 against V3 0.01% at tick 10. V3 depth is about 5,503 USDC / 3.40 WETH and about 120 USDC / 8,518 USDT0. The
executable Aqua0 price depends on backend-signed JIT ranges, which were not requested.

## Gas

Monad charges the transaction **gas limit**, not gas used (docs.monad.xyz gas pricing), even when the
transaction reverts. Foundry uses the Ethereum schedule, but Monad reprices cold state access: cold account
10100 (vs 2600), cold storage 8100 per 128-slot page (vs 2100 per slot) and ecRecover 6000 (vs 3000). The
harness therefore records the Ethereum-schedule cost and the cold accounts, slots and pages each trade touches,
and derives a Monad estimate. The [calibration](../evidence/monad-gas-calibration-143-112591595.json) checks this
model against 13 read-only `eth_estimateGas` calls on Monad. Its residual is +185 to +787 gas per call, and it
confirms per-page storage pricing.

| Pair / order               | EVM execution | Ethereum tx (+intrinsic, calldata) | Cold accts / slots / pages | Monad tx estimate |
| -------------------------- | ------------- | ---------------------------------- | -------------------------- | ----------------- |
| USDC/USDT0 Aqua → external | 1,055,155     | 1,090,567                          | 19 / 108 / 74              | 1,612,067         |
| USDC/USDT0 external → Aqua | 1,060,882     | 1,096,474                          | 19 / 110 / 76              | 1,629,974         |
| USDC/WETH Aqua → external  | 1,052,336     | 1,087,844                          | 19 / 106 / 70              | 1,581,344         |
| USDC/WETH external → Aqua  | 1,050,280     | 1,085,980                          | 19 / 105 / 69              | 1,573,480         |

The Monad estimate is an upper-leaning model: it ignores Monad's cheaper memory and SSTORE write components. It
is not a Monad-node measurement. Production gas can be higher with more signed JIT ranges or protocol fees on
the live hook.

Recommendations for the Monad worker policy (owned by `src/` and `config/` maintainers):

- `maxGasUnits` ≈ 1,629,974 × 1.3 → **2,120,000**. The reviewed owner-pilot schema currently caps
  `maxGasUnits` at 2,000,000. That is 1.23× the largest estimate, so it is workable but has less headroom.
- The worker signs with the raw `eth_estimateGas` result as the limit. On Monad that is the exact charge, but
  it leaves no headroom for state drift. An out-of-gas revert still pays the full limit.
- At the observed 102 gwei, a 1.63M-gas limit costs about 0.166 MON per attempt (0.216 MON at 2.12M), win or
  revert.
- The executor's `maxGasPrice` must exceed Monad's 100 gwei base-fee floor plus tip (102 gwei observed).
  The owner-pilot schema's `maxFeePerGas ≤ 0.05 gwei` cap cannot run on Monad.
- `config/chains.json` still lists the earlier Monad hook `0x027f…C0C8` and pool. The live hook is
  `0xA2bd…68c0`.
