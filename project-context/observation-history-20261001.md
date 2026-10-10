# Read-only opportunity and balance history

## Scope

This change completes the worker-side observation feature from the previously uncommitted `feat/rebalancer-history` work. It preserves that work in its original checkout and integrates reviewed copies on a separate branch. It does not grant trading permissions, change an executor allowlist, approve a market policy, fund a wallet, alter profit/slippage limits, or replace the authoritative transaction journal and receipt history.

A quote is not a completed trade. An estimated net profit is not realized profit. A balance change can include funding, withdrawals and fees. These distinctions are part of the API coverage notes and record fields.

## Startup and lifetime

`src/observation-runtime.ts` creates `runtime/observations.sqlite` when `observations.enabled` is true. Existing default settings enable the feature; setting it to false creates no observation database and performs no balance sampling. The coverage start is persisted immediately, even when no candidate is found.

The CLI passes the optional store to the existing runner, exposes it to the authenticated report server, and starts the balance sampler only for the continuous `run` command after the report listener is ready. The sampler uses a separate read-only RPC client with a five-second per-request timeout and no retries. An abort signal cancels outstanding reads at shutdown before the database closes. Repeated start and stop calls are safe. Failed observation storage is reported explicitly and does not replace or disable transaction accounting.

The sampling interval defaults to 60 seconds and must be between 30 seconds and one hour. There is at most one outstanding sampling pass. Known assets come from the chain registry, explicitly configured markets and currently discovered V4 pool identities. Adding DAI through pool discovery therefore does not require hard-coding it into a stale initial registry pair. The target list remains bounded at 32 token assets per chain, plus native balances, for the configured executor and operator only.

## Records and read API

Authenticated GET endpoints on the worker report server:

- `/v1/opportunities`: candidates and their outcomes, quote block identity, base/other token, class, venue, original and refreshed execution amount, and any recorded transaction identity.
- `/v1/balances`: historical balance samples and latest-per-series summaries. Both respect network, chain, wallet, role, asset and time filters. A summary that exceeds 128 series sets `seriesTruncated: true`.

The existing report bearer credential is required. The separate control credential does not grant read access. These routes are GET-only; they cannot enable a market or sign/send a transaction. They refuse cross-network queries, invalid or mismatched cursors, inappropriate filters and oversized page limits. Disabled/unavailable storage returns 503 rather than a fabricated empty history. This patch adds worker endpoints, not a new public frontend screen.

Use `network`, optional `chainId`, `from`, `to`, `limit` (1-500) and `cursor`. Opportunity queries optionally accept `state`; balance queries accept `role`, `wallet`, and `asset` (an address or `native`). Returned pages describe retained coverage and removals. No pre-feature logs are reconstructed as historical facts.

Balances are read at a pinned block, checked against the canonical block hash afterward, and include token units. Missing metadata, RPC failures and reorganizations are stored as null-valued gaps with an issue, not zero balances. A real on-chain zero remains zero. Partial sampling failures also appear in runtime status.

## Integrity and performance

Opportunity IDs bind their immutable identity. Once a transaction is known, later telemetry cannot replace its hash, execution trade ID or known execution amount, erase its linkage, or turn a submitted transaction into a rejected quote. Restarted unfinished quote work becomes `interrupted`, not successful. Actual receipts remain in the existing execution-history database.

Observation writes are best-effort diagnostics, not the durable source of financial truth. Their SQLite connection uses WAL, NORMAL synchronization and a short 25 ms lock-wait budget, avoiding the original proposal's one-second lock wait in the execution event loop. Recent observations can be lost on an operating-system/power failure; the independent transaction journal/receipt configuration is unchanged. Retention is bounded, and reports disclose removed records. Synchronous local write overhead still exists; no claim of zero performance cost is made.

## Verification and deployment boundary

This branch passed TypeScript, 165 unit tests, 47 local contract tests, 18 Python operations-safety tests, 3 local execution/deployment integration tests and the TypeScript build. The integration signer is test-only/mock KMS and the EVM is local. The inherited V4 branch also has 9 passing pinned local-fork tests for exact USDC/DAI and the original Uniswap/Sushi routes; these seed test funds and mispricing and do not demonstrate live profitability.

The worker repository did not previously have a remote staging branch or a checked-in staging deployment workflow. Publishing Git branches does not update the AWS worker or enable this feature there. The current live route permissions and worker process were left unchanged during this work. Coordinate any later release explicitly; do not represent a branch push as a running deployment.
