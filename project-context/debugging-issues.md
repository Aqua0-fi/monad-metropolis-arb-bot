# Debugging findings

## Robinhood UniversalRouter tuple differs

Resolved during mainnet-fork testing on 2026-09-17. The configured router accepted the legacy tuple
but passed a slice from the middle of the payload to the hook. The Aqua0 magic prefix was missing,
JIT liquidity was never injected, and the swap reverted. Trace evidence showed the wrong hook bytes
reaching the real PoolManager. The current Uniswap IV4Router includes `minHopPriceX36` before hookData.

Fix: pin `extendedV4Encoding` in the registry and as an immutable constructor argument. The Robinhood
row uses the extended tuple with the additional relative bound disabled; the absolute per-leg output
floor and final balance-profit guard remain mandatory. Other proven rows use the legacy tuple. All
three Robinhood fork tests pass at RPC block 65470614 after this change. This may also merit a separate
upstream frontend/backend router-encoder review; those repositories were not modified in this task.

## Arbitrum RPC height is not Solidity block.number

Resolved during the same fork run. Arbitrum fork RPC block 506134498 reported EVM block.number 25998033.
Using RPC height for the contract's short expiry would make every submitted cycle fail its lifetime
bound. The contract now exposes `executionBlockNumber()`, and submission builds the onchain expiry
from that read. RPC heights continue to control quote freshness and receipt confirmations.

## Familiar dummy private key collides with live delegated account

Resolved in the local fork fixture. The small test private key 0xB0B resolved to an address that already
had delegated code on Base. Aqua0's strategist verification correctly attempted ERC-1271 rather than
EOA recovery. Replace low-valued keys with uniquely derived test-only keys. No existing account or
live delegation was changed, and no test keys are used by the production worker.

## Public endpoint retention and local tooling

Base PublicNode served fresh state but refused older uncached storage without an archive token.
The official Base RPC served the pinned state through Foundry's transport. The evidence runner uses
`cast rpc` and records a block/hash; replay requires a provider retaining that block.

macOS sandbox restrictions caused Foundry's proxy initialization to panic and the tsx CLI IPC socket
to fail. Tests were run with appropriate local tool permissions; Node now invokes the tsx loader via
`node --import tsx` without the CLI IPC server. These failures were not protocol test passes.

## Fee-tier fixture selection

A replay exposed an unconditional `break` in the test fixture's external-pool search. It checked only
fee tier 500; Monad's active pool uses tier 3000. Put the assignment and break inside the liquidity
condition. The corrected fixture passes all three Monad cases at block 105639937. The failed attempt
is retained as `evidence/monad-fixture-discovery-failure.*`; it was a fixture defect, not proof that
Monad lacked liquidity.

## Next-day replay and public RPC availability

On 2026-09-18, several public RPCs had pruned the previous day's uncached account state. The exact
historical replay correctly failed in fixture setup. Keep those failed reports, pin a new block and
rerun; do not relabel unavailable historical state as a successful test. Fresh Base discovery also
needed the public read endpoint `https://base-rpc.publicnode.com` after the default endpoint rejected
requests. An archive-capable production/test provider is required for dependable historical replay.

## Patched executor versus pinned legacy fixture compiler

The 0.8.37 executor initially could not share a compilation unit with the test-vendored Aqua0 contracts pinned to 0.8.34. The vendor source was not relaxed or edited. The legacy fixture now calls a generated ABI interface and deploys the separately built 0.8.37 executor artifact. Both Arbitrum route orders and full rollback pass against actual Uniswap and Sushi infrastructure. The generated boundary is checked during contract verification.

## Admin surface declaration and economics

The full backend suite caught the newly mounted economic-review route missing from the explicit audited admin path list. The path was added, and all private-authentication/public-schema surface tests passed. A baseline archive initially lacked the Ponder package dependency symlink; after sharing the same complete dependency tree, only the same five existing durability/mock failures remained in both source revisions.

## Arbitrum activation exposed quote-reference starvation

The owner completed the pilot setup on September 29. A read-only check at 04:19:24 UTC found the
executor unpaused with exactly 5 native USDC, one approved SwapVM strategy and execute mode, but
79 discarded passes and zero completed passes. Sixteen candidate events were present while the
headline candidate counter remained zero. This was not evidence that no opportunity existed.

The read/requote lifecycle was checking the previous reference block before the returned quote
could replace it. A deterministic reproduction started at block 100, returned a quote at 111 with
head 112, and still refused on the original anchor despite the unchanged eight-block bound.
Preparatory reads now use an explicit task-liveness check. The actual quote is checked for age,
canonical block and approvals before adoption. Task expiry, revocation, reorg and stop cannot be
cleared by adopting a new quote. The chosen SwapVM amount/direction is refreshed once instead of
running another full adaptive search. Insufficient current inventory returns to discovery.

The final exact-call simulation now supplies its own freshness evidence. Its calldata hash is checked
before and after signing, and the same configured block/time bounds apply to that proof. This is a
bounded proof, not a guarantee that no later block or inclusion-time state change can occur. Pending
nonces, economic controls, full-call execution and onchain minimum-profit checks remain mandatory.

The route's verified native/base-token V3 pool can value gas directly, with same-block factory,
quoter, token, fee and factory-lookup validation. Every changed native cost is still quoted anew.
The earlier all-tier search remains for routes without a matching conversion pair; no zero-fee
fallback or assumed token price was added. Local read-only measurements dropped fee preparation
from about 27 seconds to about 9 seconds; host-side timing must be checked before release claims.

Candidate counts advance when a validated candidate is found, including candidates later discarded.
Unavailable SwapVM searches count as failures; they do not emit a successful empty pass. Diagnostic
reasons are retained with authenticated URLs redacted. No repair code has been activated on the live
funded worker merely by these source changes.

The tested repair runtime is commit `3e0beaddcdba0a42d6b894242c49bebff987bd99`, with 123 unit
checks, 47 contract cases, three local transaction integrations and successful push/PR CI. Its
resource-bounded host build produced image
`sha256:4ffa8e6394f59a80a1fd2caf84246878db89e974609ae4e6362cc547f3592312`.
The final isolated host-side live timing probe could not be executed through the tool safety layer.
It is therefore an explicit prerequisite inside the owner-run image update, not a claimed pass.

`python3 ops/owner-refresh-arbitrum.py --apply` requires an interactive owner and the phrase
`UPDATE ARBITRUM WORKER`. It first validates the currently staged source/image, then runs a
read-only whole-call probe without AWS signing credentials or runtime mounts. It leaves the active
service unchanged if proof freshness or the existing task-time budget fails. A successful owner
update changes only the image pin and restarts the existing service. Settings, credentials, limits,
permissions, pauses and runtime data remain intact. If a transaction becomes pending during the stop,
the helper resumes the old image without deleting it. Rollback never restores old runtime/history
files over newer execution evidence. Six isolated host-update regressions cover these boundaries.

### Provider skew found after the owner's first repair update

The owner's first image update completed at 04:46 UTC and its isolated exact-call timing probe
passed in 2.273 seconds. The continuous worker then rejected candidates before fee preparation.
A separate read-only comparison caught a quote at block 509926684 while the public RPC's latest
answer was still 509926682. The old generic freshness check treated this ordinary provider skew
as a stale/reorganized quote, even though the quote endpoint was no-store and returned current data.

`waitForRpcHead` now waits for an actual latest-head response to reach the quote or simulation
block, bounded by the existing freshness deadline and poll interval. It never substitutes a quoted
block number for RPC evidence. The ordinary block-lag, time-age and canonical-hash checks still
follow. A late RPC response, expired budget, cancellation or unreachable future height refuses.
Transient freshness mismatches are discarded as outdated work rather than inflating the error
backoff. Genuine failed scans propagate to the scheduler's failure count instead of its success
count. Three read-only live quote checks verified canonical hashes after alignment; no transaction
was signed or broadcast by those checks. The owner-run preflight must include the same head alignment
and quote freshness checks before the next image update.

### First live execution succeeded; receipt event selection prevented recording

The first owner-enabled Arbitrum trade at 04:55:04 UTC succeeded in block 509927826. The actual
receipt and its prepared record are pinned in `test/fixtures/arbitrum-first-execution.json`.
It spent 3.871550 USDC and earned 0.704396 USDC gross. Receipt gas was 0.000017603901 ETH.
The existing backend's mainnet RPC supplied the historical exact-output conversion: 0.046953 USDC
of gas replacement cost, giving 0.657443 USDC net for this trade. Setup, funding and deployment
costs are separate from this single-trade result. No LP return or withdrawal was performed.

The receipt contains both `SwapVMLegExecuted` and `Executed`. Passing `eventName` to the existing
multi-event ABI decoder did not filter its runtime topic selection: the final execution was decoded
again in the SwapVM branch and rejected as a duplicate/mismatched leg. Separate ABI projections
now decode each fact. The exact real receipt passes, including when event order changes. Wrong
identity, missing evidence and duplicate matching events still fail. The worker now exposes receipt
recording errors instead of reporting this mined hash as generically pending forever.

The ordinary public RPC had already pruned that receipt's historical state when recovery was
attempted. The existing backend mainnet RPC was read in memory for the exact historical valuation;
no provider account was created, no live RPC setting was replaced and no authenticated URL was
published. A temporary local-file run of the compiled recovery command verified preview-only
behavior, one settled record with the actual net result, and an idempotent second apply.

`src/reconciliation.ts` and `src/receipt-recovery.ts` are receipt-only paths with no runtime import
of the worker loop, wallet or KMS signer. Recovery binds the hash, chain, sender, executor, nonce,
prepared trade, canonical block and complete historical fee evidence. It persists history before
releasing the same pending journal entry, retains existing economic pauses and keeps daily gas
reservations unchanged. Journal persistence failures no longer clear pending state only in memory.

`ops/owner-reconcile-arbitrum.py` is an owner-confirmed maintenance command. It stops the existing
worker, preserves a backup, runs the receipt-only process under the runtime flock without signer
credentials, verifies persisted state and starts the repaired image with the same settings. An
uncertain recovery leaves the worker stopped; it never deletes pending evidence or restores old
history over a partial successful settlement. The new runtime still needs its exact-image build
and owner-applied release before these source fixes describe the live service.

## 2026-10-01: a healthy loop is not an eligible V4 market

The Arbitrum USDC/DAI pool feed recovered from earlier indexer timeouts, but the worker still had no eligible V4 policy. The prior loop returned successfully without pricing anything and advanced `lastSuccess`. The isolated idle-status patch now reports a skipped check; it does not enable pools or change execution. See `v4-usdc-dai-readiness-20261001.md` for exact identity, remaining consent/allowlists, preserved original history work and the disabled configuration draft.

## October 1: observation modules existed but never ran

The original history work had a store and sampler, but the CLI never constructed or started them and the report server exposed neither. The continuation wires startup, authenticated GET reads and cancellation-safe shutdown. It also fixes balance-series filters, false-success sampling status, missing DAI discovery assets, and mutable post-broadcast observation identity. None of these changes replaces the execution journal, authorizes a trade or enables a route. Focused tests cover storage failure, disabled mode, network isolation, authentication, genuine zero versus unavailable balances, stable coverage, truncation and shutdown.
