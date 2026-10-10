# Arbitrum readiness, LP wallets and economic review

## Deployed release, 2026-09-28

The authoritative deployment and verification record is `evidence/releases/20260928-readiness/release.json`. It supersedes the candidate deployment status below, while preserving those earlier test qualifications.

Backend PR598 is merged into staging at `a9d1e4ea93bda37638b8bba11f32efc9652bc2fa`, with Railway deployment `6d352914-f339-4cd3-b757-d8ae2c9ef3de` successful. Frontend PR607 and the small admin-shell follow-up PR608 are merged into staging at `06ecf1233dfab9e46da64119bdca92c772212ca0`; Railway deployment `0a55f219-4b21-4c23-9b3a-5993965c12a4` is successful. All checks on those PR heads passed. Both merges used normal branch protections and exact source-head checks.

The AWS observer remains on worker source `2a0db3043f2ee26f025e2c23105565f84735003a`, image `sha256:53e88c7854085c251e47102947ad3c3b37ba8dd618dce89be51f7994bf7f8172`. Runtime work is restricted to Arbitrum (42161), using the existing free RPC configuration. The fresh protected read at 01:56:10 UTC confirmed observe mode, zero configured markets, execution disabled and zero confirmed worker executions. Settings, credentials, approvals, operator pauses and the pending journal were preserved by the observer rollout. This documentation update does not change its image or merge worker PR3 to main.

The live protected admin pages `/?section=market-rebalancer` and `/?section=rebalancer-lps` passed at 1440- and 390-pixel widths. The replay waited for completed V4/SwapVM catalogs and successful authenticated read-only runtime refreshes. Anonymous access returned 401; there were no browser runtime errors, HTTP errors or horizontal overflow. No live operating control was clicked. The LP view defaults to Arbitrum and correctly reports no executions rather than inventing LP addresses. Older other-chain discovery rows remain in the catalog, labelled stale; they are not active runtime chains.

The full frontend suite passed 6,228 tests with the same 50 existing skips, and full lint and typechecking passed. Two real follow-up findings were retained: cold transformation of lazy strategy views was moved outside timed routing assertions without replacing the views, and a hidden public onboarding tour was excluded from the private admin host so it no longer requested the public chain catalog there. The first PR608 CI attempt separately timed out in an unchanged Solana explorer assertion. Its independent 55-test replay passed, and one unchanged-source CI retry passed the complete tests and build. No assertions, timeout limits or skips were weakened. Original failed runs and the initial live 404 evidence are retained with hashes in the release record.

The live Arbitrum catalog contained three V4 pairs (WETH/USDC, USDC/DAI and MYRC/USDC) and eleven SwapVM strategies at the recorded read. All were unapproved. Discovery is not proof of available LP backing or a profitable executable round trip. Starting a pilot still requires an owner-selected market and capital/gas limits, reviewed executor/operator permissions and funding, current full-transaction checks and separate execution enablement. No funding, public-chain transaction, price-policy value change, pair approval or live activation occurred in this continuation. The production-maker SwapVM reverse-order issue and hackathon-only 90% profit distribution remain separate unresolved work.

## Historical candidate release boundary

This is the 2026-09-28 candidate. Source implementation and local verification are complete for the LP tab, realized-fee reporting, loss pause, explicit review and single-chain selection. Staging deployment is a separate next gate and is not implied by these tests. No transaction was sent to a public chain, no executor was funded or deployed, no pair approval was added, and no live price-guard value was changed during this work.

The immediate scope is Arbitrum using the existing configured free RPC. The proposed 90% LP profit distribution is a hackathon-only follow-up, not implemented or claimed as a payout by this release. The LP page identifies capital sources, not LP losses, fee entitlement or external-DEX LP identities.

## LP-wallet tab

The protected admin navigation has Rebalancer LPs immediately after Rebalancer. Its route is `/admin?section=rebalancer-lps`; the existing admin-host rewrite applies. Arbitrum is the default chain. The page reads at most eight confirmed executions and verifies at most two receipt details concurrently. Full LP addresses, source chain, asset, class, principal amount and denominator are visible on desktop and mobile.

Confirmed principal sold requires the existing canonical per-LP vault event trail. Likely means historical planned backing only. Actual evidence takes precedence over the corresponding plan. Reorgs, missing receipts, inconsistent totals, wrong transaction/network identity and unavailable RPCs do not become inferred addresses or percentages. Wallet filtering is explicitly limited to the displayed page, not a claim that older history was searched. Each row links to the protected execution detail.

## Realized results and pause semantics

The worker now persists receipt-derived native fees and their starting-token replacement-cost valuation. Successful and reverted transactions both incur fees. The dashboard shows gross gain, native cost, token-valued fees and net result by chain and starting token. It does not add unlike units or invent USD values. The token conversion is a receipt-block valuation, not an executed conversion; hosting, deployment and other operating expenses are excluded.

Missing costs or negative results within any chain/token review-window bucket latch an economic pause. Pending transactions continue to reconcile. The gate is checked before signer access and again around signing. A pause arriving before or after signing cannot trigger a new broadcast. Lifetime results, including losses, survive restarts and reviews.

Ordinary Resume does not clear an economic pause. The separate authenticated review requires a reason, the exact displayed version and settlement watermark, and explicit acknowledgement that already-enabled markets may resume. The worker rechecks canonical receipt evidence. Missing fees, pending transactions, unavailable chain evidence, a reorg or an expired review deadline prevents clearance. Recovering fee evidence changes the version and requires another informed review. Clearing the gate never changes pair permissions, signer configuration, funding or operator pauses.

Private writes use the existing separate control credential and a fixed trusted worker origin. The read-only report token cannot review a loss. The browser uses an authenticated server action, never a public API proxy carrying admin credentials. The route is included in the audited admin surface and excluded from public OpenAPI.

## Price protection

The earlier scoped admin-policy work is retained and tested: enabled by default, with separate 500-basis-point LP and trader bands. Overrides are network/chain/pool scoped, persisted with compare-and-set versioning and audit metadata. Quote, prepared-curve and authorization paths use the policy. The form explicitly acknowledges that the policy affects ordinary V4 traders as well as the rebalancer. Deployment alone neither disables protection nor changes existing values. Live-reference, capacity, consent, minimum-trade and full-transaction requirements remain separate.

## Arbitrum-only operation

The existing chain option now applies to `scan` and `run`, not only `doctor`:

```sh
node --import tsx src/cli.ts run --config config/rebalancer.observe.json --chain 42161
```

Run from the service directory with its existing persistent runtime volume and credentials. This example remains observation-only, and an empty approved-market set remains empty. It does not deploy, fund or enable the bot. Discovery and runtime work are restricted to the selected registry chain; old catalog rows do not silently reactivate other chains. Before narrowing an existing worker, reconcile pending transactions on excluded chains. Startup refuses to abandon an out-of-scope pending hash or use a different operator for one.

RPC addresses still come from the canonical registry and existing environment override. No new provider, paid plan or node was provisioned. Full fee policies and authorization checks remain necessary before any live execution.

## Compiler and actual Arbitrum execution evidence

The executor remains pinned to Solidity 0.8.37. Legacy Aqua0 test-vendor sources remain byte-for-byte pinned to their original 0.8.34 source. A generated test-only ABI boundary lets that legacy fixture deploy and call the separately built 0.8.37 production artifact. The test interface is checked against that artifact; it is not a second executor implementation. All vendor provenance hashes still match.

At Arbitrum RPC block 509541062, hash `0x12009f87863d474eca795b1195c62857a25bfe100707d39262aa5feead92dc5b`, both venue orders and impossible-profit rollback passed against each of Uniswap V3 and Sushi V3: six executed fork cases, no skipped cases. These use actual deployed manager/router/token/external-pool infrastructure with controlled local Aqua0 vaults, JIT authorizations, inventory and price gaps. They do not establish a live profitable opportunity or production-maker SwapVM execution.

A separate fresh read-only discovery at block 509538708 verified the Arbitrum bindings and found eight liquid external pools. Discovery is not funding or authorization. The earlier Base production-maker SwapVM fixture still has one failing reverse-order case (four pass, one fail); it is retained as unresolved evidence, not relabelled an Arbitrum success.

## Verification record

- Worker TypeScript and all 84 unit tests passed, including real HTTP control authorization and economic-review races.
- Two actual local-EVM integration runs passed through local and mock-KMS signing, simulation, broadcast, receipt fee capture, pause-before/after-signing refusal and restart recovery. No real KMS signing request was made by these tests.
- All 42 non-fork contract tests passed, including the retained adversarial executor checks. The full mixed-compiler build and generated test-interface check passed.
- Six Arbitrum fork cases passed as described above.
- Frontend typecheck, changed-file lint and production build passed. The complete suite passed 6,227 tests with 50 explicit existing skips. The real LP/economics components passed controlled desktop and mobile browser checks with full addresses, working filters and no horizontal overflow.
- Backend targeted feature and admin-surface checks passed. The complete candidate unit command produced 5,488 pass, 4 skip and 5 failures. The exact five failure identities also occurred on untouched staging with the same complete dependency tree. They are shared-mock/durability batch failures, not a clean global pass. No new batch failure remains.
- Backend current and untouched-staging normalized type output is exactly equal: 11 reported diagnostics in each run. Global typechecking is not claimed clean.

Local logs and redacted evidence are in the isolated workspace's `evidence/` directory. The initial missing admin-route declaration, missing baseline Ponder dependencies and unavailable frontend-local formatter were diagnosed and corrected; their original logs are retained. Use the final result records, not those earlier failed attempts, for the candidate's status.

## Remaining gates

Review and deploy the scoped branches to staging, verify exact revisions and protected live UI without clicking real trading/price-policy controls, and preserve observer state during any image update. Production promotion must not drag unrelated staging commits along. Funded execution still requires a reviewed deployed executor, chosen limits and permissions, working backend authentication and current full-transaction checks. The remaining production-maker SwapVM fork issue needs its own resolution before that route is presented as fully proven. Hackathon profit distribution needs an explicit denominator, payout design and actual payout evidence; this release does not claim it exists.

### Registry-byte preservation

The original formatter included byte-hashed registry inputs and output. Reformatting them changed the recorded hashes without changing their JSON values. The exact original bytes are retained, those three data files are excluded from formatting, and the normal check command now independently verifies their hashes and chain identities. The complete registry is also checked against the current sibling backend source. No chain address, venue permission or risk policy was changed by this fix.

### Clean Linux CI compiler provisioning

The first remote worker CI passed all 84 Node tests but could not resolve the newer Solidity releases through its pinned Foundry release lookup. CI now provisions exactly 0.8.37 and the legacy-fixture-only 0.8.34 from official Solidity release assets, verifies their reviewed SHA256 values before making them executable, checks each version string, then runs Foundry offline against that cache. Existing compiler cache mismatches fail instead of being overwritten. The production compiler pin and all tests are unchanged. The new remote run must pass before Linux build success is claimed.

### Historical receipt review after chain selection

The explicit economic-review action retains lazy read-only access to all registered chains so an Arbitrum-only runtime can still review its own older receipts from another chain. That does not activate discovery, signing or trading on the older chain. Startup still rejects any excluded pending transaction. The focused regression verifies this separation and unknown-chain refusal.
