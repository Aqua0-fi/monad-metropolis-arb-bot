# Monad (143) owner-run V4 pilot

A short, self-terminating market-rebalancer-service pilot on Monad mainnet through the Aqua0 V4 route.
Every run is time-boxed and leaves the system OFF. The agent that built this tooling ran it only against
local anvil forks with anvil's public development key; every mainnet step below is owner-run.

## Demo checklist (Monad Metropolis, 2026-10-12)

Economics at block ~112.59M: Aqua0 fills Monad USDC/USDT0 at the backend's fixed $1/$1 start price
minus ~2-3 bps; the external Uniswap V3 0.01% pool pays ~1.0009 USDT0 per USDC. That is a ~6 bps edge.
Monad charges the full gas limit (~1.8M with headroom, ~0.18 MON, ~$0.005 per attempt), so a trade
needs roughly 20 USDC to clear gas. Aqua0 backed only ~2 USDC of USDT0->USDC at the time, so:

1. LP backing: add >= 25 USDC of LP capital on Monad committed to the USDC/USDT0 V4 pool (app action).
2. Gas: bridge (step 0) or send ~10 MON to the KMS wallet `0xd1fC4c8631E8C5d23a0C86D5890802DD70Cb4cf5`.
3. Inventory: send 20 USDC on chain 143 to the same wallet, then run setup with
   `--max-input-usdc 20 --fund-usdc 20` (the code-level hard cap is 20 USDC).
4. Operator key: `secrets/market-rebalancer-operator.json` with `AQUA0_OPERATOR_API_KEY` (staging
   `API_OPERATOR_KEY`). `/api/swap/authorize` is operator tier on staging (verified 2026-10-12).
5. Observe run, then one execute window of 10 minutes. Everything ends paused with `activeUntil = 0`.

## Backend cost controls (why a run cannot repeat the ~$1000 RPC bill)

- Every backend request passes `src/backend-budget.ts`: per-minute/hour/day caps per class, persisted in
  `runtime/monad-pilot/backend-budget.json`. The pilot allows catalog 0, search 4/min 60/h 300/day,
  authorize 2/min 10/h 30/day. A refusal idles the worker; it never retries harder.
- `v4Search.mode = "quote-grid"` (`src/v4-screen.ts`): the Aqua0 leg is estimated from the backend's own
  price feed (fixed $1 for USDC/USDT0, DefiLlama otherwise) and the external leg from QuoterV2 on the free
  RPC. Only a screen that clears pool fees, slippage, gas allowance and margin spends one read-tier
  `/api/swap/quote`. An unchanged market is never re-asked after a miss; a clamped quote records Aqua0's
  real capacity for 5 minutes. Measured: 11 scans in 20 s made exactly 1 backend call.
- Execute mode makes no backend call while the executor is paused or its window is closed.
- `--max-runtime-ms` stops the worker by itself; the onchain window stops trading even if every process dies.
- The paid `RPC_URL_MAINNET_MONAD` is never passed to the worker; it uses `https://rpc2.monad.xyz`.

## Safety model

- The executor's dead-man switch: `execute` reverts `Inactive()` after `activeUntil`. A fresh deployment
  has `activeUntil = 0` and is paused, so it cannot trade. `setActiveUntil` is bounded to now + 1 day.
- A timed run opens a window of `minutes + 90 s` grace (minutes capped at 60), runs the worker with
  `--max-runtime-ms` plus a hard wall-clock kill of its whole process group (SIGTERM, then SIGKILL after
  10 s), and always calls `setPaused(true)` then `setActiveUntil(0)` (finally block, SIGINT/SIGTERM/SIGHUP
  handlers, `atexit`), then re-reads both values onchain. If the laptop, script or session dies, the
  contract still stops trading by itself at `activeUntil`.
- Signing modes need an interactive terminal and a typed phrase. Previews load no credential.
- Owner transactions are journaled exactly like the Arbitrum flow: unsigned intent before signing, hash
  and signed bytes before broadcast, receipt and canonical-block checks before a step counts as done.
  An uncertain step is reconciled (only identical signed bytes are ever rebroadcast); nothing is blindly
  retried. Never delete files under `runtime/monad-pilot/`.
- RPC: owner commands default to the free `https://rpc2.monad.xyz` and refuse any host outside the free
  allowlist (`rpc{,1,2,3}.monad.xyz`, `rpc-mainnet.monadinfra.com`) or the value of
  `RPC_URL_MAINNET_MONAD` (the backend's PAID Chainstack endpoint). The worker child never inherits that
  variable; it uses the registry `publicRpc` (now `https://rpc2.monad.xyz`) unless the owner passes
  `--rpc`, which is allowlist-checked and then given to the worker.
- KMS: owner signers on chain 143 are one-use, digest-bound, zero-value only, and capped at 500k gas /
  0.5 MON per call and 6M gas / 2 MON per creation (`OWNER_SIGNING_CHAINS` in `src/kms-account.ts`). The
  policy file applies tighter caps first.

## Owner commands, in order

Run from this checkout after `npm ci` and `forge build`. The build must match
`config/owner-deployment-artifact-monad.json` (creation code hash `0x9c48a614…e0e2`, source `92390b0`, with
the trading window). The Arbitrum artifact `config/owner-deployment-artifact.json` is unchanged and still
describes the already-deployed Arbitrum executor.

0. Gas: `python3 ops/owner-bridge-arbitrum-to-monad.py` (preview), then `--send` and type
   `BRIDGE 0.001 ETH TO MONAD`. Relay's public quote API (no key) returns one `depositNative` transaction
   to Relay's pinned Arbitrum depository. The helper refuses anything other than: source chain 42161,
   native ETH, amount at most 0.0015 ETH, recipient and all refunds = the KMS wallet, destination chain
   143, native MON, no destination calls, guaranteed output at least 90% of the input USD value. On
   2026-10-12, 0.001 ETH quoted about 89.4 MON (minimum 86.7) with about $0.05 of Relay fees. `--status`
   is read-only.
1. Deploy: `python3 ops/owner-deploy-monad.py` (preview: real gas estimate, predicted address, maximum fee),
   then `--send` and type `DEPLOY 143`. The gas limit is the real estimate +10% because Monad charges the
   full limit. At block ~112.59M the estimate was 3,365,527 gas: a 3.70M limit at 112 gwei = 0.415 MON
   maximum (command cap 1 MON). The executor deploys paused with `activeUntil = 0`, verified onchain.
   With nonce 0 the address is `0x0C527b9B1D603863CADC1CBBc1483036ac21D252` (the same CREATE address as
   the Arbitrum executor, because owner and nonce are the same). `--status` never resends.
2. Setup: `python3 ops/owner-setup-monad.py` (preview), then `--enable` and type `SETUP MONAD 143`. It
   sets the operator (the owner wallet), `setLimits(USDC, --max-input-usdc 5, --min-profit-usdc 0.001)`,
   `setGasPriceLimit(--max-gas-gwei 200)`, `setAquaPool` for `--pools usdc-usdt0` (USDC/USDT0, fee 100,
   spacing 1, hook `0xA2bd…68c0`, PoolId `0x26d1…daad`) and `setV3Pool(0xacf8…3500)`, then transfers USDC
   from the owner wallet to the executor only up to `--fund-usdc 5` (hard caps: 20 USDC). If the owner
   wallet lacks USDC it prints exactly how much USDC to send to which address on chain 143. It finishes
   paused with `activeUntil = 0` and writes `runtime/monad-pilot/execute.json` from
   `config/monad-v4-pilot.json` (executor filled in, KMS region and key ARN from
   `secrets/market-rebalancer.kms.json`, notes stripped, market size clamped to the onchain max input,
   `allowBroadcast: false`). Rerunning is idempotent. `usdc-weth` is reviewed in the policy but not armed.
3. Observe first: `python3 ops/owner-timed-run-monad.py --minutes 10 --observe`. This makes no signature and
   no onchain write. It needs only `AQUA0_READ_API_KEY` from `secrets/market-rebalancer-observer.json`.
4. Execute window: `python3 ops/owner-timed-run-monad.py --minutes 10`, then type `RUN MONAD 10 MIN`.
   It needs `AQUA0_OPERATOR_API_KEY` in `secrets/market-rebalancer-operator.json` and refuses execute mode
   with a clear message if that file is missing. Observe mode still works. The read-only preflight checks:
   code hash, owner, router/Permit2/hook bindings, operator, limits, gas ceiling versus live price,
   allowlists, executor USDC, owner MON (open/close worst case 0.3 MON + 1 MON reserve), worker config
   (executor, operator, KMS key, `backendBudget`, chain-143-only execution, external pools allowlisted,
   market size/profit floor within onchain limits, registry hook/router), credentials present, and a free
   RPC. The per-run worker config is written to `runtime/monad-pilot/runs/<id>/worker.json` with
   `allowBroadcast: true` for that window only. The summary reports worker trades submitted/landed/reverted,
   `Executed` profit, gas in MON (gas limit × price), open/close fees, owner MON and executor USDC changes,
   and backend calls from `runtime/monad-pilot/backend-budget.json` plus the worker's
   `backend_budget_summary` line.
5. Recovery at any time: `python3 ops/owner-timed-run-monad.py --close-only` pauses the executor, zeroes
   the window and verifies the result. It needs a terminal, but no typed phrase.

## Budgets (explicit caps, not measurements)

`config/monad-owner-pilot.json`: deploy ≤ 1 MON, setup ≤ 0.5 MON in total, ≤ 0.1 MON per window open,
owner calls ≤ 250 gwei (close path ≤ 1000 gwei, so it is never priced out), 300k gas per owner call. Worker
caps checked in preflight: `maxGasUnits` ≤ 1.5M (template 1.3M), `maxDailyGasWei` ≤ 10 MON,
`maxFeePerGas` ≤ the executor ceiling (200 gwei). At the 100 gwei floor, a worst-case reverted trade costs
1.3M × 200 gwei = 0.26 MON (about $0.007 at $0.027/MON). Reverts keep principal but spend gas.

## Files

`runtime/monad-pilot/`: `deployment.json`, `setup-journal.json`, `window-journal.json`,
`bridge-journal.json`, `execute.json`, `runs/<id>/{preflight.json,worker.json,worker.log}`, `owner.lock`
(a lock left by a dead process is reclaimed so the close path can run). All files are mode 600 in mode-700
directories. The worker keeps `runtime/journal.json`, `runtime/history.sqlite` and its budget ledger in
the repository so that pending hashes and spend persist across runs.

## Verification (2026-10-12)

- `npm run check` covers `test/owner-monad.test.ts` (policy caps, limit flags, setup/funding/window steps,
  worker-config sanity, RPC guard), `test/owner-bridge.test.ts` (a real Relay quote and 17 mutations:
  wrong recipient, chain, token, refund, target, calldata, extra step, low output, expiry), and
  `test/owner-monad-signers.test.ts` (Monad signer budgets, anvil-test signer bound to 127.0.0.1,
  journal/lock, close-path reconciliation, plus `ops/test_owner_timed_run_monad.py` and
  `ops/test_owner_monad_wrappers.py`: minute cap, non-interactive refusal before credentials, missing
  operator key, paid-RPC scrub, phrase mismatch, preflight refusal, worker crash, open failure, SIGTERM,
  a signal during open, a wall-clock kill of a SIGTERM-ignoring process group, and an unverified close).
- `node --import tsx --test test/owner-monad.e2e.ts` forks Monad at a recent block on 127.0.0.1 with the
  anvil dev key, then deploys (and checks that a wrong phrase signs nothing), runs setup twice
  (idempotent), runs a one-minute observe window with the real worker CLI against a stub backend (no
  staging calls), runs an execute window whose worker crashes, then runs one interrupted by SIGTERM while
  the worker ignores SIGTERM. It asserts paused = true and activeUntil = 0 after every step and then kills
  anvil. It passed at fork block 112600650: 15 owner transactions, 0 stub-backend requests and a 62.6 s
  observe run.
- Limits of that evidence: anvil does not reproduce Monad's gas-limit charging or cold-access repricing.
  The execute windows used a fake worker, so no trade was attempted. The real worker was exercised only in
  observe mode. Relay is trusted to honour a validated order; refunds go to the KMS wallet.

## Still owner-only

Fund MON (bridge), send 5 USDC to the KMS wallet on Monad, create
`secrets/market-rebalancer-operator.json` (`AQUA0_OPERATOR_API_KEY`) for execute mode, then run steps 1-4.
