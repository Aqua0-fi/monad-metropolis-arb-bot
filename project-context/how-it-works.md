# How the market-rebalancer-service works

Think of it as a customer who buys where a token is cheaper and immediately sells the same token where
it is more expensive. These trades put pressure on the two prices to converge. It trades only when the
complete round trip meets the profit requirement. It does not force prices to match at a loss, and it
does not manufacture trades when there is no economic opportunity.

## A complete trade

1. A worker checks a configured Aqua0 pool and external Uniswap/Sushi pools on the same chain.
2. It selects a size from prepared V4/V3 liquidity curves or fresh actual SwapVM quotes, comparing
   both venue orders within your spending, backing, fee and minimum-profit limits. There is no
   manually configured sample-size list on the current search path.
3. It screens price curves with a slippage margin. These exploratory results are gross candidates,
   not verified profit after gas. Only the selected executable transaction receives a fee estimate.
4. It recalculates the selected opportunity using current shared backing and external-pool prices.
   For V4 it then asks Aqua0 to authorize the exact JIT fill. For SwapVM it verifies the current,
   already-shipped order and explicit onchain permissions. No per-swap V4 authorization is invented
   for a SwapVM program.
5. It estimates and simulates the _whole_ transaction, including both swaps and the profit guard.
   Live gas price plus the owner-requested 5% margin, actual estimated gas units and any separately
   quoted network fees are converted through a real exact-output native-token quote. The complete
   transaction is re-estimated after its profit floor changes; unknown fees refuse submission.
6. The executor exchanges the starting token for the intermediate token, exchanges that token back,
   and checks its final starting-token balance before returning successfully.

Aqua0 can be either the first or second exchange. Both legs happen on one chain and inside one call.
There is no interval where the service is committed to one completed swap while waiting to send the
other transaction. No bridge, loan or flash-loan repayment is involved.

## The check that protects operating capital

The contract reads its starting-token balance before trading. It requires:

`balance after both swaps >= balance before both swaps + required gross profit`

The service chooses `required gross profit` to cover the selected transaction's measured fee estimate
plus its required net profit. An owner-configured onchain minimum is an additional floor the operator
cannot lower. Maximum gas and spending settings are safety ceilings, not assumed transaction costs.

For example, suppose a cycle starts with 1,000 USDC, reserves 2 USDC worth of fees and requires 3 USDC
of net profit. The contract must finish at least 5 USDC above its starting balance. Returning only
1,004 USDC from that 1,000 USDC cycle fails the guard, even though the gross trading result is positive.
This is an illustrative example; actual configuration and gas conversion use integer token units.

If the second swap fails, output is too low, liquidity disappears, the signature expires, or the final
profit is too small, the entire EVM call reverts. The first swap, second swap, token transfers, approvals,
service replay flag and Aqua0's consumed authorization nonce are undone together.

The contract also refuses to spend pre-existing intermediate-token inventory on the second leg. It may
spend only tokens acquired during the first leg. Leftover intermediate tokens stay in the contract and
are not counted as profit. This prevents old inventory from hiding an otherwise losing round trip.

## What a revert cannot refund

A transaction that is included and reverts still costs network fees. It cannot roll back the chain's
fee payment. A profitable token cycle also needs to pay fees from the operator's separate native-token
balance. Profit is therefore not inferred merely from seeing two successful swaps.

The service caps gas units and gas price and checks a second owner-set gas-price ceiling onchain.
Profitability uses the actual complete-call estimate, not those ceilings. Arbitrum's gas estimate
already includes posting cost. OP Stack L1/operator charges are separately read, buffered and checked
against their configured ceiling. The journal reserves exposure before sending; this spending meter is
separate from the cost used to rank profitability. Actual mined receipts, including reversions, drive
realized P&L and the durable economic pause. Unknown or negative economics are not silently cleared.
Fee state and prices can change before inclusion: an estimate is not a guarantee against gas loss.

A simulation is a rehearsal against a particular state, not a promise that later state will be identical.
The contract's balance check is the final authority. Short expiry, fresh quotes and preflight simulation
reduce unnecessary reverted submissions. Mempool competition can still consume gas; private transaction
transport and prolonged observation are later deployment decisions.

## Exactly how Aqua0 backend information is used

The service uses the existing Aqua0 backend to understand executable liquidity depth. The current
V4 search calls `POST /api/swap/optimize-round-trip`, which prepares the same fleet planner and native
simulation primitives used by the normal quote path. The SwapVM search calls
`POST /api/swap/optimize-aqua-round-trip` and quotes the actual deployed program. Both are read-only;
normal V4 authorization is requested only for the selected, freshly checked trade.

The fleet quote service resolves the pool's actual currencies, checks strategy consent, reads fleet
capital through `buildFleetJitPlanReader`, builds the LP-preference JIT ranges with
`sameChainOnly: true`, loads the PoolManager's current state, and simulates the proposed fill. It reports
what is requested versus what it can actually authorize. This is more informative than pool TVL or a
spot-price comparison: the service needs to know what output a particular trade size can receive now.

The rebalancer rejects quotes that are clamped, partially supported, for the wrong token pair, or for
a different input amount. It takes the smaller of previewed and authorized output. It does not rebuild
the full Aqua0 liquidity model, bypass user LP preferences, or assume all committed capital is available.
The quote endpoint is read-only. The authorization endpoint subsequently rechecks eligibility/capacity,
reserves backing and signs the exact fill. Simultaneous activity can make a preview stale; that is why
it refreshes, authorizes and simulates before submission.

External V3 pools are loaded at a pinned block and priced with the prepared native concentrated-liquidity
engine, with independent QuoterV2 parity evidence. Canonical history is verified before unchanged tick
structure is reused; current price and liquidity are read again. V4 searches bracket the marginal-profit
crossing and check actual integer-rounded candidates. Opaque SwapVM programs use bounded adaptive
actual-VM evaluations, beginning with freshly re-quoted previously useful sizes. Neither path treats
spot price as unlimited depth, and the opaque-program search does not promise a global optimum.

## Permissions and operating model

The contract starts paused. The owner chooses operators, eligible Aqua0 pools, exact external pools,
per-starting-token input caps and minimum profit, and the gas-price ceiling. Operators can request
trades within those limits but cannot withdraw inventory. Only the owner can withdraw. Ownership
transfer requires acceptance. Approvals to Permit2/router are bounded to the trade and cleared afterward.

The worker has its own dedicated operator key. It never needs the Aqua0 backend's JIT signing key,
LP keys, governance key or a backend database credential. It uses the normal authenticated API surface.

One process owns each journal. It records the deterministic transaction hash before broadcasting. If an
RPC times out, the service reconciles that hash rather than sending again. Pending or ambiguous state
blocks further execution. The daily budget conservatively retains reserved costs even if a transaction
was cheaper, so a restart cannot silently reset the spending meter.

Offchain bookkeeping has a separate lifetime. An EVM revert cannot undo a database reservation already
created by the backend. For this same-chain path the existing backend expires the liquidity hold with
the signed authorization deadline. The service requests authorization only after a fresh profitable
quote, to avoid placing unnecessary temporary holds on LP capital.

## Reaction time and operator pauses

New block notifications trigger independent chain work. HTTP-only chains check their own header
approximately every 500 milliseconds; explicitly configured WebSockets provide push notifications.
A slow discovery request or another chain does not create a global sleep barrier. The best opportunity
already ready can proceed without waiting for every other venue. There is still only one execution
attempt in flight per chain, and an uncertain send blocks the next attempt until reconciliation.

A newer block or saved control change invalidates queued quotes across the chain, including markets
that share a vault. The chosen transaction is checked again against current shared backing and both
venues. Pausing globally or per chain is durable and stops new work, but keeps tracking transactions
already sent. Resuming does not add funds, change pair permissions or switch on live execution.
