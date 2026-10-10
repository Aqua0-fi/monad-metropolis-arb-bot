# Latest Arbitrum owner-start release, 2026-09-29

Read `evidence/releases/20260929-measured-pilot/release.json` and
`project-context/measured-fees-and-pilot.md` before using older checkpoints below.
The measured-fee worker source is `0f7fb6c04114a640734a605776207412711bf2ae`; its verified AWS image is
`sha256:abade56afd74dc92abd3f95003dbb446719dc4f4a5aa731f7674b347627cb36e`.
Backend PR603 and frontend PR612/613 are merged and successfully deployed to staging.
The observed actual-vault route and owner funding/refund calldata pass real Arbitrum forks.
The owner was given the single `ops/owner-start-arbitrum.py --enable` command with interactive
confirmation. At release verification the executor was still paused, the observer was watch-only,
and no owner setup, inventory conversion or mainnet arbitrage was performed by this agent.
Check the owner's local pilot journal and current chain before claiming a subsequent activation.
Do not deploy the executor again, enable other chains, clear economic pauses or send automatic LP returns.

# Context

## Latest release reference

Read `readiness-verification.md` and `evidence/releases/20260928-readiness/release.json` before continuing. The September 28 staging release includes the LP-wallet tab, receipt-based economic reporting, separate loss review, scoped price-policy controls and an Arbitrum-only observer. Backend staging is `a9d1e4ea93bda37638b8bba11f32efc9652bc2fa`; frontend staging is `06ecf1233dfab9e46da64119bdca92c772212ca0`. The existing AWS image still uses worker source `2a0db3043f2ee26f025e2c23105565f84735003a`, not a later documentation commit.

The latest protected runtime read and desktop/mobile browser replay passed. The worker has zero configured markets and execution disabled. Discovered pools and stale historical catalog rows are not approvals or active trading. Funding, a reviewed executor and explicit pilot limits/activation remain separate actions. The production-maker SwapVM reverse-order fork issue remains unresolved, and the proposed 90% LP profit sharing remains unimplemented hackathon-only work. Do not repeat completed staging deployments or infer production/main permission from this release.

## Original project context

The user requested a private service to keep Aqua0 prices aligned with other exchanges and help
bootstrap genuine trading. They subsequently required the name `market-rebalancer-service` throughout,
strong atomicity and profitability checks, and a plain-English explanation of the backend's role.

The current scope includes implementation, fork validation, protected staging updates and the existing
resource-limited AWS observer. Onchain executor deployment, funding and live trading remain separate
explicit actions and are not authorized by an observer upgrade.

Aqua0's backend registry supplies eight supported EVM chain IDs. Current integration uses `/api/swap/quote`
and `/api/swap/authorize` for the fleet V4 path. Source review confirmed `sameChainOnly: true` in the
fleet quote planner. External pricing comes from onchain Uniswap/Sushi V3 QuoterV2 calls at a pinned
RPC block. The service does not hold protocol signing keys or modify upstream vaults.

Runtime is one Node process, an embedded SQLite execution-history file, no separate database/indexer/Redis service, bounded independent per-chain work, persistent
JSON transaction journal and loopback health endpoint. The contract uses prefunded operating inventory.
Fork tests independently instantiate real Aqua0 source, use real deployed market infrastructure and
synthetically displace the local Aqua0 pool price to prove a profitable route can settle.

The source tree is independently buildable; test-only Aqua0 source provenance is in `vendor/aqua0`.
Verification evidence and unresolved deployment requirements are separate documents.

The regular-V4 Rust replacement and projected-range facade now live in the sibling backend worktree.
This worker still uses the backend quote/authorize interfaces and full-transaction simulation; it does
not bypass the planner or duplicate LP consent logic. The existing admin UI now reports worker history,
canonical receipts and actual per-LP principal sold, with historical backing shown separately.
See `rebalancer-reporting.md`, `simulator-audit.md` and `delivery-verification.md` before continuing.

Automatic sizing and SwapVM implementation are described in `swapvm-sizing-plan.md`. Native V4
search preserves the real planner and reservation-netted backing. SwapVM uses actual deployed VM
quotes with a real caller and independent owner-controlled onchain allowlists. Discovery and policy
updates never imply funding or execution activation. The generated worker registry must include
canonical SwapVM bindings and known router header widths; run `scripts/sync-registry.ts` against the
specific backend source revision instead of hand-copying addresses.

The reactive-loop branch replaces sleep-after-all-chains scheduling with independent new-head lanes,
bounded per-chain quote concurrency, queued-state invalidation and latest-state whole-trade checks.
Pool caches retain verified math data, not LP approvals or available shared backing. Global/per-chain
pause controls and live reporting are implemented but not deployed merely by being present in source.
Read `reactive-loop-plan.md` and the release evidence before continuing or making performance claims.

## October 1, 2026 observation continuation

Reviewed copies of the existing uncommitted history feature are integrated with CLI startup/shutdown and authenticated GET reporting. See `observation-history-20261001.md` for scope, tests, diagnostics-only durability and deployment limitations. The original `working-dir/rebalancer-readiness-20260928/worker-review` checkout remains untouched. USDC/DAI route configuration remains disabled; see `v4-usdc-dai-readiness-20261001.md` rather than mistaking code publication for live trading activation.
