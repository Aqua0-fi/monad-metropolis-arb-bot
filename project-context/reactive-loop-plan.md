# Block-driven arbitrage work

The previous worker slept after a complete all-chain pass. That made slow discovery, one failed RPC,
and every additional market part of every other market's reaction time. This change removes that
architecture rather than reducing a sleep constant.

The worker reacts to new block headers. An explicitly configured WebSocket RPC uses subscriptions;
HTTP-only chains use independent short header checks. A slow chain has its own work lane and cannot
hold the other chains behind a shared await. Each chain retains exactly one pending latest-state
request, not a growing queue of obsolete blocks. Discovery runs separately from trading scans.

A newer state replaces queued work. Work already in progress is discarded on a reorganization,
shutdown, time budget, or when it falls outside the allowed block lag. Do not abort every calculation
on every faster-chain block: that can starve the worker permanently. The existing confirmed-receipt,
nonce, spending, authorization, and full-transaction simulation checks remain in force. Cancellation
must not release an account lane while its operation is still running. Never discard a transaction
hash that might have been submitted.

State caches contain verified pool math only, not LP permissions, available vault capital or signed
authorizations. Their keys include the actual client/network and block hash. Between blocks, reuse
V3 initialized-tick data only after verifying the prior canonical hash and reading all intervening
liquidity-change logs; otherwise reload. Re-read current price, active liquidity and fee state.
Capacity and approvals remain fresh inputs, and the selected trade still needs an execution check.
Caches are bounded and process-local; a restart begins from verified chain reads, not stale disk data.

Tests must demonstrate concurrent chain progress, bounded backlog, reorg/cancellation behaviour,
unchanged journal safeguards, and cache invalidation on liquidity changes and failed reads. Measure
header-to-start and scan durations separately from native calculation time. No benchmark can establish
live competitive profitability, which also depends on RPC latency, inclusion and actual opportunities.

No funded executor deployment, trading activation, new pair approval, production promotion or bypass
of an external tool permission block is part of this implementation.

## Implemented and checked

The running loop now uses one latest-head lane per active chain, four chain lanes maximum, four
backend optimization reads globally and two reads per chain. Selected-trade refreshes take priority
over queued exploratory reads. Ready profitable routes do not wait for an unrelated slower venue.
The queue is invalidated by a newer head or changed saved controls. Provisional quotes within the
explicit age/block limits can trigger a fresh recheck rather than starving a fast chain; they do not
permit signing. The final whole-transaction simulation must match the latest known state at signing
and again before the signed transaction is recorded and sent.

WebSockets are used only when an operator explicitly configures the corresponding environment-variable
name. Otherwise the per-chain HTTP header check defaults to 500 milliseconds. This is the interval
between header checks, not a promise of 500 ms transaction execution. A slow in-flight RPC is not
mistaken for a completed operation. Discovery, receipt reconciliation, quote preparation, numerical
search, authorization, signing and chain inclusion are distinct latency components.

SwapVM evaluates both route orders concurrently, sharing four read slots. Its default evaluation
budget is one second after state preparation, with up to forty sizes per direction. Previously useful
sizes are fresh quote inputs, never cached prices. The public prepared-state request has a six-second
read budget with actual HTTP cancellation. Neither budget guarantees an arbitrary VM program's
mathematical optimum. A larger budget can inspect more points at the cost of state age.

An actual Base V3 replay at blocks 51800169 and 51800172 matched eight cached native quotes against
full fresh state, including both directions and range-crossing sizes. Initial cold hydration took
4034 ms / 9 RPC requests; a verified subsequent-block refresh took 1037 ms / 6 requests; a full cold
reload of that same subsequent block took 3616 ms / 8 requests. Same-block reuse took 299 ms / 1
canonical-hash request. These are observations through a public RPC from the development Mac, not
production inclusion timings. Exact records are in `evidence/releases/reactive-loop/`.

That replay also exposed a genuine integration defect in the preceding implementation: its prepared
V3 and SwapVM readers omitted an explicit Multicall3 address even though the backend client has no
viem Chain descriptor. The address now comes from the existing fleet client definition. A regression
requires that same chain-neutral call shape, so a chain-configured test cannot conceal the defect.

## Operator controls and telemetry

Global and per-chain pause state is restart-durable, network-scoped and version-checked in an embedded
SQLite store. Pausing stops new price work and transmissions; already-sent transactions continue to
be reconciled. Resuming preserves other chain pauses and every existing pair permission, spending
limit, signer and execution-enable setting. No deploy, funding or trading-enable operation was added.

Live reporting includes block-feed transport and age, active/queued chain work, bounded timing samples,
read-queue pressure and recent decisions. The admin UI labels observe-only separately from execution,
shows failed or stale reads as unavailable, and requires a confirmed save before saying a pause was
applied. Timings are worker work-pass durations, not a measured time from price change to chain inclusion.

The UI polls a protected server action; it never sends the admin credential through the public API
proxy. Its browser verification uses synthetic local status and random test-only Basic Auth credentials.
A local hostname mismatch in the test harness caused recursive Next dev rewrites; the harness now uses
localhost consistently without changing the production auth/host gates.

## Remaining deployment boundary

This implementation is now deployed to the authorized staging applications and existing AWS
observe-only service. The exact release record is `evidence/releases/reactive-loop/release.json`.
Backend PR597 merged as `cd825654ffd1b97703c456d39584fbe28a13de5d`; the final frontend includes PR605 and the
presentation-only pagination follow-up PR606, merged as `aaf1e2be680883efb9f8b93c2e3167a910406865`.
The worker runs image `sha256:fd3905313444dadae8228523e9b45db2a3e8f47b6b40d3c7b1e48cee48f53d26` from source `9e7970a641596d6b3dba0a4b0f711194e4af3c80`.

The protected live page was verified on desktop and mobile: HTTP 200, block-driven status, available
pause controls, a six-row initial SwapVM list, no visible errors and no horizontal overflow. The
verifier clicked no live operating or pair-permission controls. Actual local synthetic-data tests
separately exercised authenticated pause/resume saves, version conflicts and stale-refresh races.

The bot remains watch-only with zero configured markets and zero execution-enabled chains at the
verification time. The cutover preserved settings, credentials, pair permissions and transaction
history and backed up runtime data before changing only the image pin. No funded executor, new pair
approval or live trading activation was performed. Runtime controls do not supply those permissions.

All backend CI checks passed. Local backend type/error baselines and inherited batch failures remain
reported separately. The full frontend suite passed 6,195 tests with 50 skipped; its CI still has
inherited global lint failures outside these changes, so full frontend CI is not claimed green.
