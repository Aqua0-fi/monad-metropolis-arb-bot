# Simulator parity, multi-chain rebalancing, and liquidity attribution

## Scope and order

**Current instruction: leave the production simulator unchanged.** The first fork comparison has
reproduced discrepancies. Preserve the failing tests and evidence, but do not apply simulator fixes
without a further user instruction. Any later expansion must report this known limitation rather
than silently treating those routes as parity-verified. The brief local loop edit was reverted to
the exact pre-test source hash before any corrected replay.

The first deliverable is a differential audit of the existing backend simulator against actual
execution on local blockchain forks. Multi-chain expansion and the dashboard follow only after the
quote paths they rely on are measured and material discrepancies are corrected or explicitly blocked.

The service remains `market-rebalancer-service`. Both trade legs and the starting-token profit guard
remain atomic in one transaction on one chain. "Across chains" means independent same-chain cycles,
not bridging halfway through an arbitrage. No mainnet transactions, deployments, funding, production
migrations, changes to hosted environments, or implicit enablement of broadcasting are in this scope.

## Upstream integration and preservation

Fetched on 2026-09-23. Integration worktrees are siblings under
`../working-dir/rebalancer-expansion/` relative to the original Aqua0 checkout. The existing frontend
has substantial uncommitted work and is not reset, stashed, or overwritten. Existing contracts have an
untracked deploy helper that is also left untouched. Baseline status, dirty-file hashes, and private
patch backups are retained outside the repositories.

| Repository                      | Baseline       | Commit                                   |
| ------------------------------- | -------------- | ---------------------------------------- |
| backend                         | origin/staging | 777487864615b2952b6b5249808d17b76cfce436 |
| contracts                       | origin/main    | 6df233d6063771ba8dc2c40a4a02ac9356ff6335 |
| web-app                         | origin/staging | ccfd06ee9a50aa6d042e90200bd73268faf4d287 |
| aqua0-market-rebalancer-service | origin/main    | 200556595fc2a46bff27253da7565f7b5c3fd73e |

All worktrees use `feat/rebalancer-parity-attribution`. Backend staging includes recent V4 sizing,
range-depth, reserve and chain-registry changes absent from the old feature checkout. Test the current
code rather than reimplement those fixes. Staging is an integration baseline, not a claim that all its
changes are deployed to production. Refetch before handoff and reconcile further upstream changes
without overwriting uncommitted work. Do not promote staging to main or publish a package implicitly.

Contract submodules stay at their recorded commits. In particular, the deployed SwapVM router must
not be inferred from a newer upstream SDK or an unpinned source checkout. Resolve addresses through
the canonical registry and validate the deployed bytecode and chain ID on every fork target.

## Phase 1: simulator differential audit

### Establish the real call paths

Trace the V4 quote/authorize planner into `uniswap-delta-simulator.ts`, the pool-state loader, tick
math, JIT band sizing, fee calculation and router encoding. Separately trace the Aqua/SwapVM quote
path, its actual program decoder and the bound deployed router. Identify whether a result is a
backend mathematical estimate, a router quote call, an EVM simulation, or a confirmed transaction.
They must not be reported as equivalent evidence.

Use the existing actual-router fork fixtures as building blocks rather than adding a second fake
exchange implementation. The old rebalancer fork tests validate guarded execution but do not by
themselves compare the current backend's quoted amounts with execution; close that precise gap.

### Reproducible execution harness

1. Pin a source chain ID, RPC block number and block hash. Read-only remote RPC access supplies the
   fork; every mutation targets a locally owned loopback Anvil instance or Foundry's in-process fork.
2. Assert the intended manager/router bytecode exists and record code hashes, deployed ABI variant,
   compiler/dependency revisions, source hashes and normalized non-secret configuration.
3. Freeze the full pre-swap state used by both calculations: pool key, slot0 including LP/protocol
   fee, active liquidity, initialized ticks/bitmap, LP ranges/amounts, token decimals, program bytes,
   amount, direction, exact-in/out mode and explicit price limit.
4. Call the real backend function from its actual source. Do not copy its formulas into the oracle.
   Read snapshot phases at one block. A multi-call snapshot of changing latest state is not a valid
   differential comparison.
5. Execute the corresponding real swap on the fork, inspect transaction success/revert, logs, actual
   token balance deltas and final pool price/tick. Restore a snapshot before each comparison case.
6. Emit machine-readable records containing raw integer expected/actual amounts, absolute errors,
   relative errors when the denominator is nonzero, and the exact source of each value. Record
   reverts, partial fills, unavailable historical state and unsupported configurations as such.
7. Run a small set of representative observed market states as well as controlled fork states.
   Controlled funding, seeded ranges, local hooks, price displacement and impersonated local roles
   are explicitly labeled; none is claimed as a live profitable opportunity or production API proof.

Use local-only test identities. Never read or reuse protocol signer/operator secrets. Do not ship or
reship live strategies outside the backend relay. Keep authenticated RPC URLs and private execution
logs out of source and reports. Tests clean up only the processes they created.

### Cases selected for discriminatory value

- Both token directions and exact-in/exact-out, with 6/18-decimal and equal-decimal pairs.
- A normal in-range fill, an exact initialized-tick boundary, negative ticks/bitmap word boundaries,
  a fill crossing several ranges, and a gap followed by further liquidity.
- Baseline pool liquidity plus JIT liquidity; inactive injected ranges; overlapping and unequal LP
  ranges; one-sided inventory where spot requires both assets.
- LP fee versus direction-specific protocol fee, dynamic fee unsupported cases, and price limits.
- Small atomic-unit trades and genuinely insufficient liquidity, including partial fills and the
  exact-out remainder. A protective error is preferable to silently inventing liquidity.
- Snapshot coverage exhaustion and mixed-block reads. Missing tick words must not be treated as
  proof that the omitted region is empty.
- For SwapVM: actual opcode table/program, virtual reserve scaling, concentrate bounds, fee opcode
  order and token direction; compare backend output, bound-router quote and real swap balances.
- Router tuple/version and EVM block-number domain differences already found by the rebalancer.

Observed code-review candidates to test, not yet proven findings: the V4 no-progress guard runs before
zero-amount boundary crossing; execution stops on a liquidity gap; the snapshot drops slot0 fee fields;
and the default snapshot covers a limited tick region without exposing that limit to the simulator.

### Failure classification and corrections

Classify each mismatch before editing: arithmetic/rounding, JIT planner sizing, snapshot scope or
staleness, ignored fee/price limit, unsupported hook effects, router/ABI mismatch, and fixture error.
Prove the minimal failing case on the unmodified current upstream code first. Fix the production path,
retain a focused regression, and replay the actual fork case. Do not relax tolerances to make tests
pass. Token output and price comparisons use integer equality where the model promises exactness;
any permitted dust difference needs a derivation tied to specific onchain rounding operations.

Amount prediction and LP accounting are separate checks. A trade output match does not establish that
LP fee attribution or per-range accounting also matches. Extend diagnostics only when they describe
real captured state, not an invented post-swap price.

Exit gate: representative runnable V4 cases have recorded real-execution comparisons; every material
mismatch is fixed and replayed or causes the dependent route to remain blocked. Record independently
what was and was not verified for SwapVM and production deployment variants.

## Phase 2: registry-derived multi-chain operation

The current backend registry marks eight EVM chains launched: Base, Arbitrum, Avalanche, Celo,
Polygon, Monad, Robinhood and Arc. This is a registry fact pending per-chain RPC/deployment checks,
not a claim that every pair has a liquid external market. Solana is outside the user's EVM request.

Derive chain identity, token identity/decimals and deployment addresses from the current registry.
Avoid another hand-maintained chain allowlist. Discover eligible Aqua0 pool/class pairs through the
backend's actual route/schema and supported external pools through onchain reads. Preserve explicit
pair selection and per-chain risk settings; no automatic expansion of trading permissions.

Separate readiness states: registered, RPC reachable, deployment verified, market discovered,
quote parity verified, executor configured, funded, observed, and execution enabled. Expose why a
chain or pair is blocked. Missing venues, zero addresses, unknown router encoding or absent fee
support disable that route; never synthesize a tradable pool to satisfy a coverage count.

Preserve independent nonces, confirmations, RPC freshness, budgets, daily spend, pending reconciliation
and journal ownership per chain. One broken RPC or pending chain must not corrupt another chain's
state. Keep bounded concurrency and backoff so expanding the registry cannot saturate RPCs.

Fee policy is chain-specific. Arc has native USDC represented in 18 native decimals and ERC-20 USDC
with its own decimals; do not assume native gas is ETH or infer fee conversion from a same symbol.
Retain OP Stack extra-fee handling and the Arbitrum execution-block distinction. Validate each router
variant on that chain's fork. Update test-only vendored Aqua0 sources only with exact provenance.

Only add a new external venue/SwapVM executor path if its adapter and complete guarded round trip
have their own fork proof. Observing an unsupported route must never enable it for submission.

Exit gate: every launched EVM chain is represented with truthful readiness, supported routes have
meaningful execution/fee coverage, and configuration remains observe-only with broadcasting off.

## Phase 3: per-swap liquidity-provider attribution

### Identity and source of truth

Identify a rebalance by `(chainId, transactionHash, executionLogIndex)` plus block hash and operation
ID. Resolve its Aqua0 swap ID from the authorized payload and actual settlement logs. Do not classify
all pool swaps, or all transactions by a similarly named wallet, as rebalancer executions.

Reuse the backend's existing authorize-time `swap_jit_breakdown`, allocation records and settled
fleet-event feed. The capacity database and Ponder database are separate; join in the application.
A planned authorization is not a settled trade. Preserve the actual historical allocation at the time
of that swap instead of reconstructing it from today's balances/preferences.

Inspect existing durable columns and log fields first. Prefer a read model over new infrastructure.
Add the smallest immutable capture or migration only if the needed historical identity/allocation is
missing. Never edit the Ponder indexer incidentally: its build changes require a deliberate cutover.
No production migration execution is authorized by this implementation task.

### Percentage semantics

Expose the percentage's denominator and evidence level explicitly:

- Planned allocation per input/output asset: each LP's recorded amount divided by the recorded total
  of that same asset. Never add USDC units, WETH units and raw liquidity units together.
- Settled contribution: only amounts supported by actual settlement/credit data linked to the swap.
  Where settlement proves a total but not an LP split, label the split as the recorded allocation or
  estimate, not exact onchain attribution.
- V4 active-liquidity/fee participation: depends on which price intervals the swap traversed. A flat
  share of total deposits or the sum of heterogeneous range liquidity is not an execution share.
- Fee credit: reuse confirmed fee-credit records and their states; planned fee estimates are separate.

Aggregate multiple positions for one LP without losing the underlying class/range provenance. Use
integer arithmetic and explicit deterministic display rounding. Missing or inconsistent historical
records produce `partial`/`unavailable` attribution with coverage, never fabricated 100% totals.

Preserve distinctions between the capital owner, strategy author and operating/trader wallet. Token
pair identity is chain plus token addresses; symbols alone do not identify assets. Do not collapse
assets across chains without the registry's explicit canonical relationship.

### API and access

Add paginated, bounded read APIs for executions, summaries and a per-swap contribution drilldown.
Filter by chain, pool, pair, date window and execution status. Cursors include stable tie-breakers;
chain predicates cannot disappear when a slug is unrecognized. Surface data lag/partial coverage.

Operational authorizations and private allocation records remain behind the appropriate server-side
credential tier. Ship any privileged route with its OpenAPI exclusion. Never place service/operator
keys in browser code. The frontend route map and existing API proxy remain the sole request path.

Exit gate: a deterministic real/fork execution can be traced from receipt to swap to historical LP
records, and asymmetric multi-LP cases reconcile without claiming unsupported precision.

## Phase 4: cross-chain / pair dashboard

Integrate into the existing current web app, not a disconnected mock product. Use existing navigation,
query hooks, API client, route map and components. The dashboard is read-only, with no new transaction
signing or activation control.

Provide chain/pair/time filters, per-chain readiness, execution history, a selected swap's LP shares
and the exact basis/coverage of those shares. Separate failed, pending, reverted and confirmed cycles.
Do not turn query errors into zero activity. Include empty, loading, error and stale-data states.

Report gross profit by asset and actual gas by native asset. Only show a combined net fiat figure
when there is a valid historical conversion with its source and timestamp; otherwise show the missing
conversion rather than treating it as zero. Do not aggregate incompatible token units across chains.

Use the repository's wallet identity and server-side authentication conventions. Test actual filter
behavior, cursor paging, unavailable attribution, partial totals and a receipt-linked drilldown.
Verify the page in a local browser at desktop/mobile sizes when the environment permits. Seeded
preview data is visibly labeled and never substituted silently for a failing live API.

## Validation and delivery policy

Tests must catch a plausible regression or demonstrate an actual property; no count targets,
assertions against constants merely defined by the same test, or snapshots unrelated to behavior.
Keep independent EVM execution as the simulator oracle. Existing full suites complement, rather than
replace, the differential proofs. Record existing typecheck error sets separately from newly introduced
errors; equal counts are not proof of equivalence.

Run affected backend tests, contract tests, rebalancer checks/integration/forks and frontend checks.
Do not hide a failed or unavailable fork behind a skipped test reported as passed. Preserve useful
failure evidence and before/after discrepancies. Recheck original worktree hashes before handoff.

At milestones, update the relevant existing Aqua0 vault pages and append a single real finding to its
log, following the vault's own instructions after locating it. Do not create a replacement STATUS page.
Provide exact changed paths, revisions, commands/evidence, remaining limitations and deployment steps.
No push, merge, publish, live activation or infrastructure change is implied by passing local tests.

## Explicit task queue

The implemented order was: (1) finish the authorized regular-V4 Rust integration, preserving the
planner and backing checks, (2) durable rebalancer execution and historical LP attribution,
(3) the read-only dashboard, and (4) final end-to-end and upstream verification. The first
rebalancer registry/readiness changes have passed local checks. No live trading is enabled. The first simulator proof and Aqua trace are recorded in `project-context/simulator-audit.md`.
The trader source-escrow gate is weaker than generic LP fronting: record that distinction as a
separate design/security follow-up, not as a simulator fix. No changes to fronting execution are
authorized merely by documenting this issue.

## Progress

- [x] Acknowledge requested priority and preserve existing working-tree changes.
- [x] Fetch upstream and establish isolated integration baselines.
- [x] Read current simulator, registry and attribution entrypoints; record this plan before edits.
- [x] Establish the first real V4 differential baseline: two exact controls and four reproduced mismatch cases.
- [x] Implement and prove the regular-V4 Rust core, native binding and block-pinned reader.
- [x] Compare controlled and observed pool state against actual local fork execution.
- [x] Finish the planner-facing native integration and regression checks.
- [ ] Deployment gate: execute the Linux native API image build/load test; the local Docker daemon is not running.
- [x] Implement registry-derived chain configuration, readiness reporting and execution-policy guards; local checks pass.
- [x] Observe all eight registered EVM chains with read-only deployment/market checks; retain blocked/partial outcomes.
- [x] Verify local guarded execution/history and real-PoolManager LP events without enabling trading.
- [x] Implement actual onchain LP principal-debit attribution plus separately labelled historical backing.
- [x] Integrate and verify the protected read-only dashboard, production build, filters and desktop/mobile layout.
- [x] Reconcile final upstream drift and record verification/handoff evidence; original checkout hashes unchanged.

## Earlier simulation design question and scope decision

The user wants a shared simulation approach that can support V4 and Aqua/SwapVM, including future
custom instructions. Trace the actual live quote and settlement paths first. Current Aqua quotes
delegate to the deployed router VM, while V4 uses the backend delta approximation. A candidate
design is a common interface over venue-specific real-EVM quote/execution adapters with pinned
state, not a second hand-maintained interpreter for every opcode. Static quotes and full execution
readiness must remain distinct. The subsequently authorized replacement is regular-V4 Rust only. Arbitrary hook and SwapVM
execution remain outside this implementation scope. No live deployment has been changed.

## Latest priority: regular V4 Rust replacement

The user has now authorized replacing the old V4 simulator with an accurate, fast Rust engine.
The prior hold is superseded for REGULAR, HOOK-FREE V4 ONLY. SwapVM and custom hook simulation
remain out of scope. The immediate order is Rust math and immutable snapshots, real-PoolManager
differential execution, native Bun integration and measured performance, then compatible caller
migration. The registry/readiness changes, LP attribution and dashboard have now followed that priority.
No live deployment is authorized.

The package-specific implementation/validation contract is in
`../backend/packages/v4-simulator/README.md`. Keep old failure evidence and do not remove old
callers before verifying their behavior and the replacement packaging.

## Current implementation and remaining release gates

The compatible V4 facade now uses the tested native engine; it no longer runs the old TypeScript
swap loop. LP selection and backing controls remain intact and their regression checks pass. This
is regular V4 plus standard projected-range math, not arbitrary hook or SwapVM execution.

The worker has durable indexed execution history and a separately authenticated read-only reporter.
The existing admin area has chain/pair/time filters, receipt-linked drilldowns and per-chain readiness.
Actual LP shares come from uniquely matched, canonical per-LP principal-sale events, reconciled to
vault and V4 settlement totals. Historical backing percentages remain separately labelled. No Ponder
change or new production database migration was needed. The real fork LP proof matches two LPs'
actual principal decreases at 75% and 25%; seeded funding is not live market demand.

The implementation is locally verified, not deployed. Linux native image execution remains unverified
because Docker is not running. Arc remains blocked without a reviewed V4 execution policy/pool/external
venue, Celo's configured pair has no discovered supported external liquidity, and one Base discovery
read was partial. Correctly refusing these routes is part of completion, not permission to invent
liquidity or turn off safety checks. See `project-context/rebalancer-reporting.md` and
`project-context/delivery-verification.md` for configuration, exact evidence and baseline caveats.

Full-result native timing is not uniformly faster than the old simplest TypeScript control. Keep the
measured distinctions between raw Rust, the Bun boundary, RPC state loading and end-to-end execution.
