# Price-arbitrage execution reporting

## Scope

This reports `market-rebalancer-service`, the two-leg same-chain price-arbitrage worker. It is not the
cross-chain repayment, fronting or repatriation worker. Registering more chains means running separate
atomic cycles on each chain, not bridging between the two legs of a trade.

The earlier observer and dashboard are deployed to the authorized staging environment; subsequent
source updates are separately versioned. Check `staging-rollout.md` and the latest release evidence
for the exact deployed revisions. Onchain executor funding and live execution remain disabled.
The dashboard uses the existing admin authentication boundary. Live runtime status and pause/resume
controls use `/api/admin/market-rebalancer/runtime` with a separate worker control credential.

## Persistence and recovery

The existing JSON journal remains the authority for pending transaction hashes, exclusive execution,
failure thresholds and reserved gas budgets. A new embedded SQLite file, `runtime/history.sqlite`,
stores immutable execution identities and receipt history. This is an embedded local file, not an
additional database service. Node 22.13 or newer is required.

History is persisted before the pending journal is reserved and before broadcasting. The deterministic
transaction hash, executor, operator, pool, pair, amount and minimum profit are captured without
persisting the operator key, signature or authorization hook payload. Receipt history is committed
before the pending journal entry is cleared. A required missing history row or a failed history write
keeps the transaction pending rather than authorizing a duplicate send. A legacy journal entry made
before reporting existed can still reconcile, but its missing metadata is not invented or backfilled.

An execution record marked pending is not proof that the network accepted the transaction. The report
separates acknowledgement of the broadcast from a canonical receipt. A crash before sending can leave
a prepared row with no acknowledgement; the dashboard labels that uncertainty. Confirmed receipt
records include block hash/number, event indexes, actual profit and execution gas. Each detail request
rechecks the canonical chain before asserting a current LP breakdown. A reorganization or unavailable
RPC hides the LP split instead of presenting stale amounts as verified.

SQLite uses WAL and FULL synchronous commits. Retain the whole runtime directory on a persistent
volume, keep a single worker per existing execution journal, and use a SQLite-consistent backup or
stop the worker before copying the database. Copying only the main database while ignoring a live WAL
is not a reliable backup. The node process must be able to write the runtime directory. Files are
created with restrictive permissions. The report service has no write or activation endpoint.

## Private reporting connection

The worker keeps its normal trading API credentials. It does not need a backend admin key.
Reporting uses a separate random secret shared only between the worker and backend:

| Process | Setting                           | Meaning                                                                                                     |
| ------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Worker  | `REBALANCER_REPORT_TOKEN`         | At least 32 characters; no default secret. Missing means reporting routes reject every request.             |
| Worker  | `REBALANCER_REPORT_HOST`          | Defaults to loopback. A container deployment needs an explicitly chosen private-network binding.            |
| Worker  | `REBALANCER_REPORT_PORT`          | Defaults to 9091.                                                                                           |
| Backend | `MARKET_REBALANCER_REPORT_ORIGIN` | Trusted server-side origin of the worker report listener; HTTP or HTTPS, no path, query or URL credentials. |
| Backend | `MARKET_REBALANCER_REPORT_TOKEN`  | The same dedicated read-only reporting secret.                                                              |

Do not put this token in a query string, public environment variable, browser code, source control or
command-line screenshot. Use private networking or authenticated transport for a non-loopback
connection. Never expose the report listener directly to the internet as a substitute for admin auth.
No secret was created or configured in a live environment by this implementation.

The worker serves `/health`, authenticated `GET /v1/status`, `GET /v1/executions`, and
`GET /v1/executions/:chainId/:transactionHash`. Non-GET requests are refused. The backend exposes the
read model under `/api/admin/market-rebalancer` and its execution-detail subpath. They require the
existing admin credential tier and are excluded from public OpenAPI. The web app uses its existing
server-only admin transport, not a browser proxy with privileged credentials.

Set the worker settings' `networkMode` explicitly for a fork (`fork`) or mainnet (`mainnet`, default).
This labels and partitions reports; it does not create a fork or rewrite RPC endpoints. Configure the
worker's RPCs, API URL and the backend's network mode consistently. Mismatched network reports fail
closed. Do not reuse the same runtime journal when changing the configured execution network.

## What the LP percentages mean

### Actual principal sold

For a freshly verified confirmed transaction, the backend checks the actual executor calldata, caller,
target, pool ID, two-leg token direction, input and minimum profit. It then checks the canonical block,
execution event, actual profit, gas and settlement IDs. Only then does it inspect the LP event trail.

The current vault's `StrategyPrincipalSold` events give each local LP's actual principal debit.
They must come from the registry-resolved vault and the correct class, occur inside the same swap's
event window, and sum exactly to both the negative `ClassVenueSettled` delta and the corresponding
negative `V4SwapSettled` delta. Spoofed emitters, another swap's debits, mismatched totals, missing or
removed events and ambiguous trails do not produce an actual percentage. Older deployments lacking
the complete event trail remain unavailable.

Each percentage divides that LP's principal debit by the total principal sold in the same token,
chain and class for this Aqua0 swap. The amount, denominator and log indexes are retained. These are
not shares of total pool TVL, the external exchange, fee earnings or a mixture of unlike token units.
A fronting beneficiary can own the proceeds while another LP supplied the local principal; the UI
calls the debited address the liquidity source rather than conflating those roles.

### Planned backing

The existing backend `swap_jit_breakdown` holds the authorization-time backing plan. The reader joins
it to the independently verified swap ID, pool, class and real chain ID. It handles the historical
JSON representations, groups by source chain and token, and sums repeated positions for one LP.
Malformed or missing records produce unavailable or partial coverage, not an invented 100% split.

Planned percentages are deliberately separate from actual principal debits. An unavailable capacity
database does not invalidate an independently proven actual event trail. No Ponder schema or indexer
cutover is required. No new production database migration was introduced.

Integer arithmetic is used for all raw amounts. Display percentages use deterministic largest-remainder
rounding so a complete group sums to 100.00%. No address is identified by token symbol alone.

## Dashboard behavior and limitations

The admin panel supports chain, pool/pair, token, status and UTC time filters. History uses bounded,
filter-bound keyset pagination. Equivalent UTC timestamp formats are normalized before comparison.
A failed history query is shown as unavailable, not zero trades. Unknown decimals show raw units.

Profit remains in the cycle's starting token. Execution gas remains in the chain's native token.
For OP Stack receipts, extra fees are reported only when the necessary fee fields are available;
otherwise total network cost and net profit remain unavailable. The dashboard does not silently assume
zero extra fees or invent a historical fiat conversion. Arc's native USDC scale is distinct from
ERC-20 USDC's scale.

Readiness cards distinguish blocked, unconfigured, unverified, failed-scan, observe-only and enabled
states. A registry entry, discovered external pool or successful quote is not evidence of funded
execution. There are no activation controls in the dashboard.

## Verification and deployment gate

The real local executor integration signs and mines a two-leg trade, restarts the history store, and
verifies its exact profit/event/gas after recovery. Its saved transaction and receipt are independently
checked by backend tests. Separate tests reject altered pool labels, token direction, emitters, gas,
canonical block, caller and missing execution evidence.

The real Base fork LP proof uses the deployed PoolManager and token contracts with locally deployed
current vaults/hook and seeded LP funding. The backend receives the actual EVM logs and recovers the
two LPs' 75%/25% shares, matching their independently measured principal decreases. This is controlled
execution evidence, not an observed profitable mainnet opportunity.

Desktop and mobile Chromium checks render the real dashboard component with the app stylesheet.
The fixture is explicitly labelled and never appears as a production fallback. The checks submit
filters and confirm LP percentages are visible without sideways scrolling. The full web app build
and frontend test suite pass with the documented Node/jsdom test setting.

Before production activation: review executor permissions and funding, acquire the correct API/RPC
credentials, validate real deployed variants and fee policies per chain, build and smoke-test the
Linux native API image, review upstream simulator license terms, configure persistent runtime storage
and the private reporter connection, observe real markets, and explicitly authorize execution. The
local Docker daemon is not running, so the Linux native image build has not been executed here.
See `delivery-verification.md` for the final evidence and baseline limitations.
