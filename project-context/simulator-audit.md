# Simulator audit and Aqua lifecycle trace

## Historical baseline and current implementation

Read against backend `777487864615b2952b6b5249808d17b76cfce436` and contracts
`6df233d6063771ba8dc2c40a4a02ac9356ff6335` in the isolated integration worktrees.
These are source revisions, not an assertion that every live deployment has that exact code.
The pre-change TypeScript simulator was captured at SHA-256
`d001a51cd3372e8d5cd69fe62203ab72887359f53fb44eec25dfa77c12fece7f`.
The user initially held corrections pending an architecture decision, then authorized a regular
hook-free V4 Rust replacement. The historical findings below describe that baseline, not the new facade. The regular-V4 Rust
replacement and compatible projected-range caller migration are now implemented in this isolated
worktree. No live backend deployment has been changed. See the simulator package README and
`delivery-verification.md` for replacement evidence and deployment gates.

## V4 execution evidence

The real deployed Base PoolManager was exercised at RPC block 51697808, block hash
`0x05c8e797a5441eee12c78db8467f9ebd5e964db31b247601965f17d75de1f3b3`.
The manager code hash was
`0x83b2af6e9f3158defc2811cbcb0db71ecf8b2ba2abea39c39e370ac5c6f43eb6`.
Locally created tokens, a fresh pool and funded ranges are controlled fork fixtures. A minimal
real unlock callback settled actual ERC-20 balance deltas; the expected output came from importing
the current backend function, not a copied formula or mock exchange.

Two normal controls matched raw integer input/output exactly. Four independent cases reproduced
three related termination problems: exact-input and exact-output swaps at an aligned tick boundary,
traversing a zero-liquidity gap, and activating an initially out-of-range position. At the aligned
boundary, the backend returned zero while actual output was 996006981039903 raw units for input 1000000000000000. Across the gap, predicted output was 1496554276216664 versus actual output
3948585914476881, and the backend incorrectly stopped before spending the requested input.

The loop tests for zero token movement before applying a legitimate tick transition, stops on zero
liquidity even when another range can be reached, and returns early when injected liquidity is
initially inactive. Those are retained baseline findings; the current native engine has separate
passing boundary/gap proofs. Historical evidence is under `evidence/parity/`; the actual
harness is `contracts/test/parity/BackendV4Parity.fork.t.sol`, with the backend import bridge at
`backend/packages/api/scripts/parity/v4-simulator-ffi.ts` in the sibling worktrees.

An additional protocol-fee probe was blocked by the provider's archival-storage requirement. That
is an infrastructure limitation, not a demonstrated simulator mismatch. Code inspection does show
that the snapshot discards decoded protocol/LP fee fields and the model reads the pool-key fee;
that separate behavior has not yet been established with the blocked execution case. Snapshot
loads also do not pin their multi-phase reads to one block. The function does not expose a predicted
post-swap price; the evidence records the actual onchain final sqrt price and tick without inventing
a matching backend field. These tests do not prove production API authorization, JIT planner sizing,
LP fee accounting, live profitability, or every chain/router deployment.

## Which simulation path Aqua actually uses

The normal Aqua quote route calls `swapService.quote`, which resolves the canonical deployed
SwapVM router and invokes its `quote(order, tokenIn, tokenOut, amount, takerData)` by `readContract`.
The Aqua cross-chain source quote delegates to the same function. The V4 quote path at the baseline instead used
the JIT planner and TypeScript delta approximation. That facade now calls the regular Rust engine;
it still does not execute the Aqua/SwapVM instruction program. Shared types/imports in venue-neutral files
must not be mistaken for running the V4 model on the Aqua branch.

Sources: backend `src/routes/swap.ts:419-452`, `src/services/swap.service.ts:158-207`, and
`src/services/v4/crosschain-swap-venue-quote.service.ts:311-378` (paths below `packages/api/`).

The pinned SwapVM source runs the order program against the router's instruction table and Aqua's
virtual balances in quote mode, with `isStaticContext: true`. Its actual swap runs the program with
`isStaticContext: false` and then executes token transfers and maker hooks. Quote success therefore
does not establish approvals, physical backing, transfer behavior or full settlement success.
The actual caller/taker context also matters for future caller-dependent instructions.

Source: contracts `vendor/swap-vm/src/SwapVM.sol:111-211`.

## Virtual strategy versus physical liquidity

Shipping installs a strategist-authorized order/program and virtual token reserves in Aqua. It does
not escrow that reserve amount in the adapter. Ship/reship checks `vault.availableFor(classId)` at
that time, but the reserve is not an exclusive hard reservation and can later become stale.

During a real swap, the router prices the trade before its transfer hooks. AquaAdapter's
`preTransferOut` pulls the full priced output from the output-token vault using `settleVenueOut`,
records the returned per-LP allocation and approves Aqua for that exact transfer. The input arrives
through Aqua, and `postTransferIn` measures the ledger increase/receipt and credits the input-token
vault using the original sourcing allocation. Both legs are one transaction; failure reverts it.
The hook does not recompute the curve to turn an unaffordable quote into a smaller fill.

Sources: `src/aqua/AquaAdapter.sol:645-743,1093-1097`; `src/vault/AssetVault.sol:859-930`.

Aqua's virtual balances evolve with swaps. Separately, the backend reship worker compares depth and
price drift, checks authorization and backing, and may explicitly dock the old order and ship a new
one. This is a periodic/configuration-dependent lifecycle, not an automatic range rewrite inside
every trade. The source trace alone does not establish that a worker is running in production.

Sources: backend `aqua-reship-worker.service.ts:549-571`, `aqua-reship-trigger.ts`, and
`aqua-reship-execute.deps.ts:217-241`; contracts `AquaAdapter.sol:571-633`.

## Cash safety and double-counting are different from quote accuracy

The actual vault sale is bounded by both shared deployable idle and the class committers' free
principal. Per LP, free principal is:

`max(principal - max(deployedByLp, asyncHeld) - frontHeldPrincipal, 0)`

Shared deployable idle is bounded by `sharedIdle - frontReservedAssets - segregatedFees`.
A successful sell reduces the sourcing LP's principal and shared idle. Merely exposing the same
capital through several strategies does not let those strategies independently spend copies of it.
Later pulls must pass the changed accounting again.

Sources: `src/vault/AssetVault.sol:508-526,859-891,1596-1597`;
`src/vault/lib/PoolLib.sol:330-377,418-430`.

`availableFor` is not the same view as summing free principal: it takes the minimum of global idle
and the class's committed principal minus class deployment. In particular, a source front lock raises
an LP's `frontHeldPrincipal` before the later commit raises global `frontReservedAssets`. A code-level
example is a sole LP with 100 units and an 80-unit Locked front: free principal is 20, but the class
view can still advertise 100. A 50-unit pull then fails the actual free-principal gate. This example
is derived from the source, not claimed as an additional executed fork case. It illustrates how
stale or permissive advertised depth can coexist with a restrictive cash backstop.

## Cross-chain fronting lifecycle

On the source chain, an owner's `requestFrontLock` checks free principal and adds a per-LP hold.
`commitFrontLock` hard-reserves the amount from shared idle; release debits source principal,
reservation and idle before transferring the real tokens toward the bridge. IDs and state
transitions reject overwriting/reusing an existing front.

On the destination chain, the filler supplies actual local capital. Opening an obligation records
the filler, beneficiary, pledge and fee, and commits the beneficiary, but does not mint a duplicate
spendable principal balance for that beneficiary. When an eligible trade draws the filler's tokens,
the sourcing allocation is rewritten so the pledged portion's proceeds belong to the beneficiary;
`redirected` is capped by the pledge. This is allocation accounting, not a virtual-reserve resize.

When the bridge lands, the measured receipt is credited once under the settlement ID. Settlement
restores what was actually redirected to the filler, pays bounded fees, and gives the residual to
the beneficiary. It does not blindly repay a whole pledge that never sold. Shortfalls are bounded
by real received tokens rather than creating a fictitious repayment. Cross-chain guarantees also
depend on the authorized Composer/backend and bridge workflow; the destination vault cannot read
the source chain directly.

Sources: `src/vault/lib/FrontLockLib.sol:34-140`; `src/vault/AssetVault.sol:1269-1331,1372-1468`;
`src/vault/lib/FrontObligationLib.sol:61-187,241-314`.

The backend additionally reserves matched filler backing before recording/starting a front. V4
reservations use the same global ledger, whose durable store locks by LP and logical asset and
separates mainnet/fork storage domains. A failed or unavailable atomic reservation refuses that
managed authorization. These reservations coordinate backend-managed operations; they are not a
new EVM balance and cannot by themselves block a direct permissionless SwapVM call.

The normal Aqua quote/prepare path performs eligibility checks and returns a quote/calldata, with
no per-trade backing reservation. It must not be described as universally consulting that ledger.
The onchain free-capital gate remains the final guard. This trace identifies control boundaries,
not a completed adversarial proof of every concurrent fronting race or timeout path.

Sources: backend `fronting/fronting-matcher.service.ts:515-527,783-835`,
`backing-reservation.ts:661-706`, `v4/v4-jit-backing.service.ts`, `routes/swap.ts:546-608`.

## Redesign implication, not an implemented change

A common interface could expose venue-specific quote results and separate full-execution evidence.
For Aqua, preserve actual deployed VM execution rather than reimplementing every opcode in
TypeScript. For V4, execute the real manager/JIT sequence against the same pinned pre-state.
Future instructions still require a compatible deployed router/instruction table, correct caller
and taker context, and explicit strategy-policy support; simulation support is not authorization
to ship arbitrary programs. Quote mode and transfer-hook execution remain distinct.

Performance should be measured using reusable pinned state, batched reads and bounded caches keyed
by chain, block/hash, deployment/code, caller, program and inputs, rather than assuming a fresh fork
process per quote or asserting unmeasured latency. No replacement or production correction is
applied while the design decision is pending.

## Source-lock waiting, retry policy and a distinct trader-path ordering gap

The trader cross-chain state machine holds at `source_settled` until the source-swap finality
predicate succeeds. At `source_final`, an unobserved source escrow causes `releaseClaim` and a
later worker retry BEFORE destination FRONT_OPEN/delivery. An accepted delegated lock is not
reported as escrowed. Lock submit errors release the pending hold for another attempt; accepted
but unobserved locks suppress new submissions for a configurable window (default 300000 ms).
That suppression is an in-memory map, not a durable replacement-transaction journal.

A confirmed destination-delivery revert is terminalized for manual review, not blind replay or
automatic refund: the source input already moved and an obligation may still exist. Pending or
indeterminate delivery is observed rather than treated as successful. This depends on the worker
being configured and running; source inspection does not establish production liveness.

There are TWO different escrow gates, and their guarantees must not be conflated:

- Generic LP `authorizeDestinationFront` requires Committed or Released, validates the lock's
  source/owner/class, checks value coverage, and applies a commit-age finality predicate while
  Committed. These are configured age-based checks, not a cryptographic cross-chain state proof.
- Trader-swap `buildProvisionSourceEscrow` accepts Locked OR Committed, without the same
  identity/size/commit-age gates at this point. Source owner/class checks and Locked-to-Committed
  happen in `releaseSourceLeg`, which is downstream of confirmed destination delivery.

The vault permits an owner to cancel a still-Locked front after `cancellableAt`; an admin may
cancel it earlier. A cancellation releases the held principal. A fresh lock may also be reorged
even though the earlier source swap passed its finality check. Therefore the trader path must
NOT be described as waiting for a final hard-committed repayment reservation before exposing
the filler. This is a source-level ordering gap. The existing source-lock test explicitly accepts
Locked. A full end-to-end adversarial cancellation/reorg execution and deployed-revision audit
have NOT been performed; no production or contract correction is applied here.

Relevant source: backend `services/v4/crosschain-swap-source-lock.ts:113-155`,
`services/v4/crosschain-swap-execution.service.ts:604-754,1446-1451,1749-1788`,
`services/v4/crosschain-swap-reconcile.ts:260-319`,
`services/fronting/fronting-matcher.service.ts:392-451`,
`services/fronting/fronting-delegated-lock.service.ts:71-84,195-229,319-338`,
`db/crosschain-swap-store.ts:1829-1837`; contracts `src/vault/lib/FrontLockLib.sol:152-174`
and `src/vault/AssetVault.sol:1333-1338`. Backend paths are below `packages/api/src/`.

Verification: the existing source-lock, delegated-lock, generic-fronting matcher and trader
execution suites completed successfully on the recorded upstream worktree. They validate the
implemented waiting/retry branches; their success does not repair or disprove the weaker Locked
acceptance. The private run log is `source-lock-retry-tests.log` under the session backup directory.
