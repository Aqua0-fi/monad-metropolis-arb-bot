# Rebalancer staging readiness and operating controls

## Current priority

The owner narrowed the immediate showcase to Arbitrum with the existing free-tier RPC, improved bot economics, and an LP-wallet tab beside Rebalancer. Profit sharing is hackathon-only follow-up, not a production commitment. `readiness-verification.md` records the latest implemented source and evidence; earlier Base investigations remain historical and must not be confused with the current Arbitrum fork proof.

## Scope

Implement the requested changes on separate feature worktrees based on current staging. Preserve all original checkouts and teammate work. No live funding, trades, executor deployment, automatic execution activation, or implicit disabling of price protection. Source and UI changes go through staging verification before a separately verified production promotion. Do not include unrelated staging changes in production without review.

Backend baseline: cd825654ffd1b97703c456d39584fbe28a13de5d.
Frontend baseline: aaf1e2be680883efb9f8b93c2e3167a910406865.
Worker baseline: 4ea5ba4d15314ab9b3336d0399ea9ec7dd39c267.
Backend and frontend branch: feat/rebalancer-guard-economics.

## Work queue

1. Verify canonical external V3 pools, actual Aqua0 pools and shipped SwapVM orders on Base. Record block/hash, code identities, token identities, factory linkage, quote coverage and precise blockers. Prepare observe-only route configuration; discovery must not grant execution permissions.
2. Exercise a current Aqua0 SwapVM order through its actual deployed maker adapter and vaults on a local fork, without reshipping a strategy or using a live signing key. Distinguish router success, vault delivery, full round-trip profit and policy refusal.
3. Build a patched compiler candidate without silently changing test-vendored protocol contract provenance. Replay existing and adversarial checks and real-fork coverage against the new executor artifact.
4. Account for successful and reverted transactions using actual receipt fees. Persist source/valuation provenance and label unknown values. Show profitable trades, gross profit, fees, net result and losses on the existing protected admin panel. Do not combine different raw token/native units or invent USD conversions.
5. Add a durable loss-based pause requiring manual review. Preserve pending transaction reconciliation while paused. Define the evaluation window, realized results and data-unavailable behavior explicitly. Missing cost evidence cannot permit more trades or reset losses.
6. Add admin-managed price-deviation policy with persistent audited settings, scope limited by network/chain/pool, independently adjustable LP/trader bands, safe enabled 5% defaults, authenticated server-side writes, optimistic concurrency and explicit public-trader impact. Apply coherently at quote, prepared-curve and authorization boundaries. No live policy values are changed merely by deployment.
7. Run targeted failing-before/passing-after tests, existing regressions, type-error-set comparisons and browser QA. Refresh staging before integration, review teammate deltas, run CI and verify exact deployed staging revisions. Do not waive protection/registry gates to claim a release.

## Observed gaps

The existing worker has receipt history, daily native-fee limits and a failure counter, but not the requested full realized-profit-minus-fees pause rule. OP Stack fee fields need careful normalization and proof; an absent extra-fee field is not zero.

The V4 price guard is in packages/api/src/services/v4/jit-price-sanity.ts. Both deviation bands are hard-coded at 500 bps. It is called by fleet quoting, authorization, legacy JIT and the prepared V4 curve. Changing only quote behavior is insufficient. Existing Solana imports of those constants must not be incidentally relaxed by an EVM-pool admin policy.

The compiler candidate initially failed to build because the legacy V4 fork fixture imports vendor sources pinned exactly to 0.8.34. That is a fixture/compiler compatibility issue, not a demonstrated executor failure. Preserve that failed log and do not edit the original shared vendor tree.

## Verification policy

Keep canonical receipt/block and transaction identity checks. A revert is zero realized trading gain and a real gas expense, not a successful empty trade. Any net result using conversion is labelled with its denomination, observation block and method. Real deployments and actual profitable trades remain distinct from local fork evidence.
