# Arbitrum launch completion

Scope: finish the remaining Arbitrum showcase work using existing free RPCs. Keep all trades on one chain. Preserve atomic execution, profit floors, receipt recovery, LP consent, current price-policy defaults and the separate memory project. Public transactions, funding, live market approvals, price-policy changes and execution activation are not performed by this implementation session; prepare reviewed owner-run inputs instead.

## Reconciled baseline

The September 28 readiness release already deployed the LP-wallet tab, receipt fee accounting, durable economic pause/review and scoped price-policy controls to staging. The older expansion worktree is not the latest release. Worker source is based on 0096894. Backend launch baseline is d9432708; frontend launch baseline is 113cf100. New work uses feat/rebalancer-arbitrum-launch. Do not rebuild those completed features.

## Remaining work

1. Verify the current KMS public key against the expected operator address without signing. Check Arbitrum funding read-only and prepare unsigned deployment/setup transactions with clear costs and a 5 USDC input cap. Funding the operator is separate from funding the executor.
2. Resolve the production-maker fork issue. The older reverse test displaced an external pool by 100,000 units and then demanded nearly the entire virtual inventory from a small real vault. Preserve this failing evidence. Test realistic bounded displacement and both route orders using the actual Arbitrum maker, vaults and deployed routers, with only local test balances. Enforce a physical output upper bound during prepared SwapVM search without bypassing full-transaction simulation.
3. Implement the hackathon-only 90% LP return path. Base it on confirmed net gain after receipt fees and losses, not quoted gain. Require complete canonical actual-principal evidence; planned backing is not payout entitlement. Keep unlike tokens separate, use deterministic integer allocation and reject duplicate execution identities. Provide a reviewed, replay-protected payout mechanism and local EVM proof. No live payouts or automatic production commitment.
4. Verify changed source, security behavior, current fork fixtures and the protected UI. Record exact successes, failures and unresolved live gates. Staging updates must preserve existing runtime state and teammate changes; production promotion is separate.

## Acceptance

Never turn a unavailable read into zero gas, a missing LP into a guessed recipient, a static quote into execution proof, or a wallet deposit into permission to enable every market. No total-completion claim without source and execution evidence. No new paid infrastructure or background training is needed.

## Deferred: broader liquidity comparison and guarded execution

Owner-requested follow-up, after the Arbitrum launch: evaluate Tycho and aggregator quote feeds for supported protocols, rather than maintaining isolated price probes for every venue. This is a later task, not part of the current deployment gate.

Start with read-only discovery and block-aligned quote/simulation comparison; measure real protocol/chain coverage, fee treatment, state freshness, authentication and running cost. Tycho provides separate indexing, simulation and execution components; no assumption that one integration supports every protocol or every custom hook. Reference: the official propeller-heads/tycho repository and its simulation/execution documentation.

Only promote a discovered route to execution after an exact adapter/allowlist, independent fork proof, current Aqua0 backing/consent and whole-transaction profit checks. Retain same-chain atomicity, old-inventory isolation, durable nonce/history handling and manual-only LP returns. UniswapX/Fusion indicative intent prices are not silently treated as synchronous contract-call output.

The current MarketRebalancer is not an upgradeable proxy. Expanded execution therefore means a reviewed new executor version and explicit owner-controlled inventory/configuration migration, not mutating this deployed bytecode. Preserve the old version for reconciliation, review any new callback/approval surface, and do not implement an unrestricted arbitrary-call bypass.

## 2026-09-29 measured-fee and owner-command completion

Actual V4 fee/spacing propagation is merged to backend staging through PR603 and browser staging
through PR613. The deployed resolver now recognizes the real non-default pool keys without weakening
strategist consent. Classes 1/2 lack consent; approved class 102 separately has no usable LP-preference
plan. These are not permission to auto-approve or invent liquidity. The first pilot uses the independently
proven actual-vault SwapVM route instead.

The worker's candidate search is gross-only until the complete transaction is estimated and simulated.
Its fee floor uses live gas price plus 5%, actual call gas, real network extras and a verified native-asset
conversion. The source includes a one-command owner setup, private durable intent journal and local-fork
proofs for both the observed arbitrage and exact-USDC funding/refund. No live setup or trade was executed
by the agent. Publish and verify the new observe-only image before emitting its owner activation receipt.

### Verified release cutover

Worker CI runs 36508103659 and 36508098393 both passed on `0f7fb6c`. Its resource-bounded AWS
build and no-network runtime smoke passed. The image-only cutover verified unchanged settings,
credentials, market permissions, operating/economic controls and pending journal. It remained
observe-only, Arbitrum-only and at zero stored executions. Exact backup and image identifiers are
in `evidence/releases/20260929-measured-pilot/release.json`.

The protected deployed LP and rebalancer pages passed at 1440 and 390 pixels: anonymous 401,
authenticated 200, no runtime/HTTP errors or horizontal overflow, and no operating controls clicked.
A verified local owner-start release receipt now exists under the ignored `runtime/owner-launch/`.
Needle message 2018 delivered the one-command owner entrypoint. No mainnet financial action was
performed to manufacture a successful launch result.
