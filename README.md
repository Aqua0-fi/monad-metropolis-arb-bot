# Aqua0 market-rebalancer-service

Latest candidate: [Arbitrum readiness, LP wallets and economic review](project-context/readiness-verification.md). This records local verification separately from staging deployment and live activation.

Private service for bringing Aqua0 market prices closer to external exchanges through profitable,
atomic, same-chain round trips. Service name: `market-rebalancer-service`.

The Solidity contract holds a bounded operating balance. The TypeScript process obtains actual-size
quotes, chooses a profitable cycle, obtains Aqua0's signed JIT authorization, simulates the complete
transaction, and submits only if all checks pass. Both swaps and the final profit check happen in
one transaction. A failed check reverts both swaps. Reverted transactions still consume network fees.

**Default: observe only. The existing AWS observer and protected staging dashboard are deployed.
No mainnet executor from this repository is funded or enabled. The automatic-sizing/SwapVM update
is separately versioned; consult `project-context/staging-rollout.md` for the actually deployed revision.**

## Run locally

Requirements: Node 22+, npm, Foundry 1.5.1 / Solidity 0.8.34, Python 3 for fork evidence.

```sh
git clone --recurse-submodules https://github.com/Aqua0-fi/aqua0-market-rebalancer-service.git
cd aqua0-market-rebalancer-service
npm ci
npm run check
npm run test:integration
npm run doctor -- --chain 8453
cp config/rebalancer.example.json config/rebalancer.local.json
# Set explicit strategy approvals, maximum input, minimum profit and fee budgets before economic observation.
node --env-file=.env --import tsx src/cli.ts scan --config config/rebalancer.local.json
```

`doctor` verifies chain IDs, contract bytecode, router/hook PoolManager bindings and liquid external
pools. It does not sign, reserve Aqua0 capital, deploy, or send transactions. `scan` performs one
search pass; `run` repeats passes and serves loopback `/health` on port 9091. Observation calls only
Aqua0's read-only quote endpoint. The authorization endpoint is called only in explicitly enabled
execution mode after a candidate survives a fresh quote.

## Components

- `contracts/src/MarketRebalancer.sol`: atomic execution, inventory limits, owner-set gas price cap,
  minimum profit, venue/pool allowlists, replay protection, short deadlines and authenticated callbacks.
- `src/`: registry validation, Aqua0 client, Uniswap/Sushi V3 quoting, bounded size search, gas economics,
  whole-transaction simulation, signing, transaction journal and worker.
- `config/chains.json`: Aqua0 deployment snapshot and official Uniswap/Sushi deployment provenance.
  Includes Base, Arbitrum, Avalanche, Celo, Polygon, Monad and Robinhood. Availability is checked onchain.
- `contracts/test/MarketRebalancer.fork.t.sol`: real mainnet infrastructure with local Aqua0 vaults,
  actual signed JIT hooks and deliberately displaced local pool prices.
- `evidence/`: pinned blocks, block hashes, test output and measured gas. These demonstrate execution,
  not a promise of live profit or a production-backend authentication test.
- `vendor/aqua0/`: unmodified, hash-pinned Aqua0 contract source used only by fork tests. No sibling
  repository, private package token, server, database or operator key is required for local unit tests.

## Tests and limits

```sh
npm run typecheck
npm test
npm run contracts:test
npm run test:integration
python3 scripts/fork.py --chain 8453
python3 scripts/fork.py --chain 42161 --venue-index 1
# Replay a recorded block with an archive-capable RPC:
RPC_URL_BASE=https://your-provider.example python3 scripts/fork.py --chain 8453 --block BLOCK
```

Fork tests are opt-in and never silently replaced by mocks. See
[verification](project-context/verification.md) for what was actually tested and chain-specific limits.

The implementation supports Aqua0 **V4 JIT** or an approved **SwapVM** order against a
Uniswap-compatible **V3** pool, including Sushi. SwapVM keeps a separate discovery/policy namespace,
current program identity and receipt anchor. It does not support Aerodrome's distinct interface,
V2 pools, bridges or cross-chain cycles. External pair liquidity must actually exist. Celo's configured pair had
no liquid supported external pool in the recorded discovery pass, so it produces no route.

Read [how it works](project-context/how-it-works.md),
[operation and deployment](project-context/runbook.md), and
[remaining work](project-context/tech-debt.md) before enabling execution.

## Execution history and arbitrage dashboard

The current worker uses the registry-derived eight-chain configuration and preserves per-chain
execution review gates. It records actual submissions and receipts in embedded SQLite alongside the
existing JSON transaction journal. Node 22.13 or newer is required. No extra database service is needed.

The existing web app's admin area includes `/admin?section=market-rebalancer`. It shows chain/pair/time
filters, execution history and independently verified LP source shares. Actual onchain principal sold
and planned authorization-time backing are separate views; missing evidence is not fabricated.
The worker and backend use a separate read-only report token. See
[reporting configuration and recovery](project-context/rebalancer-reporting.md) and
[verification and deployment gates](project-context/delivery-verification.md). No live activation is
implied by local tests or by appearing in the chain registry.

## Automatic sizing and scheduling

V4 searches reuse the prepared native concentrated-liquidity curves, bracket the marginal-profit
crossing, and inspect real integer-rounded candidates within inventory, backing and policy limits.
Opaque SwapVM programs are quoted by the deployed VM with the intended caller, using bounded
adaptive multi-bracket exploration. That result is the best actually evaluated size, not a guarantee
of a global optimum for an arbitrary program. Both venue orders are compared. The worker refreshes
only the selected opportunity and simulates the complete atomic transaction before signing.

The earlier deployed observer used a 15-second sleep after each scan. This source branch replaces
that loop with the new-block scheduler described below; a rollout record is required before assuming
the running host uses it. Discovery is separate from price work. Configured quote-fee budgets and
an intended SwapVM caller remain necessary for economic observation; allowing a pair does not enable trading.

## New-block reaction and live controls

`run` no longer sleeps after a combined all-chain scan. Each configured chain receives its own new
block notifications (explicit WebSocket connection or a 500 ms HTTP header fallback). Discovery is
separate from price checks. Ready opportunities enter one execution lane per chain; older queued
prices are discarded on changed shared state, and the selected route is rechecked using current
backing, prices and a whole-transaction simulation.

The protected admin dashboard reports current mode, per-chain work, block connections, queued work,
measured timings, recent decisions and transaction history. Global/per-chain pauses persist across
restart and never stop reconciliation of a transaction already sent. They cannot deploy, fund or
implicitly enable trading. See [reactive-loop plan and evidence](project-context/reactive-loop-plan.md).

Optional scheduling configuration (all values are explicit worker limits, not profit guarantees):

```json
{
  "scheduling": {
    "headerPollMs": 500,
    "websocketAuditMs": 5000,
    "maxConcurrentChains": 4,
    "maxScanMs": 8000,
    "maxScanBlockLag": 8,
    "websocketEnv": { "8453": "BASE_REBALANCER_WS_URL" }
  }
}
```

Only name a WebSocket variable when it is actually provisioned. Missing variables use the HTTP
fallback and report the condition. Neither subscriptions nor passing local tests establish live
competitiveness; RPC latency, opportunity size, execution fees and inclusion still need measurement.

`npm run test:heads` runs real local Anvil HTTP/WebSocket notification tests. `npm run test:integration`
checks the actual local signing/sending/receipt flow and cancellation before transmission.
