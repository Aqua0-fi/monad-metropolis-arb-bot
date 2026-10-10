# Runbook

## Initial observation

Use `config/rebalancer.example.json` as a shape example only. Choose a real strategist-approved class ID,
amount grid, starting token, net-profit floor and maximum input. Decimal strings are raw token units,
not human token amounts. All RPC and API secrets are supplied through environment variables; copy
`.env.example` to an ignored `.env` and use Node's `--env-file` flag or an external secret manager.

`AQUA0_API_KEY` and, where required by the backend's caller-binding middleware,
`AQUA0_CALLER_TOKEN` belong to a dedicated service identity. Do not copy the backend signer's key.
Auth or capacity failures stop that quote. Do not weaken the backend's authentication to make the
service work. A caller-token renewal mechanism must be selected before unattended production use.

Observation requires gas-budget configuration so reported opportunities include fee economics, but
it does not require an operator private key or deployed executor. The example uses zero address
placeholders for those fields and `allowBroadcast: false`. Replace them before execution.

## Onchain preparation

`node --import tsx scripts/deployment-plan.ts --chain 8453 --owner 0x...` emits deployment calldata
and an ordered setup guide. It broadcasts nothing. Deploy `MarketRebalancer` with the registry's router,
Permit2, Aqua0 hook and tuple-format flag. It starts paused. From the owner account:

1. Set a dedicated operator and the gas-price limit.
2. Allowlist exact Aqua0 PoolKeys and exact external V3 pools verified by `doctor`.
3. Set small per-token maximum input and minimum profit.
4. Confirm the backend signs for this chain's configured UniversalRouter and the Aqua0 hook permits it.
5. Supply a strictly limited operating token balance to the executor and a strictly limited gas balance
   to the separate operator account.
6. Verify onchain configuration and simulate on a fork with the intended budgets before unpausing.

Set the actual executor/operator in the private config. Execution additionally requires both
`mode: "execute"` and `execution[chainId].allowBroadcast: true`. These switches do not bypass contract
controls. No script in this stage runs these deployment/funding/unpause steps on mainnet automatically.

## Fee settings

`maxGasUnits * maxFeePerGas + l1FeeReserveWei` is the native-token fee budget for a candidate. It is
converted to the starting token and increased by `gasCostBufferBps`. `l1FeeReserveWei` also covers
OP Stack operator fees. Base/Celo preflight calls both fee oracle functions and refuses to submit
if either is unavailable or their buffered total exceeds the reserve. An older oracle therefore needs
an explicitly implemented/tested adapter before that chain is enabled, never a silent zero fallback.
Arbitrum's gas estimate includes its data cost; the separate reserve is an extra conservative allowance.

Profitability does not include server/RPC subscription expenses. Those must be subtracted when
measuring business profitability during the later hosting decision.

## Single replica and crash handling

Run exactly one process per journal, with a dedicated operator account. `runtime/worker.lock` excludes
a second local process. Keep `runtime/journal.json` on durable storage. After an unclean shutdown, inspect
the journal and confirm the former process is dead before manually removing the stale lock.
Do not remove the journal to clear a stuck transaction or reset a daily budget.

For a pending hash, check the same chain and account. Receipt reconciliation waits for configured
confirmations and checks that its block hash is canonical. An absent/replaced/dropped transaction
stays blocked and requires an operator to investigate. This version deliberately does not implement
automatic replacement, fee escalation or blindly reused nonces.

`/health` is on loopback port 9091. It returns 503 if no recent successful scan exists. Logs are JSON;
RPC URLs and long hex secrets are redacted from errors. There is no public admin API.

## Later hosting decision

No capacity assessment has been performed and no AWS resources have been changed. The service runs
without its own chain node, database, indexer or Redis. Remote RPC quality, API rate limits and network
latency matter more than adding CPU cores to the search loop. Fork tests require Foundry and much more
RPC activity; they should not run in the production worker container.

Before choosing AWS versus the physical machine, measure existing host CPU, memory and disk headroom,
then observe this service's RSS, scan duration, RPC count and error rate with the intended market set.
The Docker image runs as a non-root user. For Kubernetes later use one replica, durable journal storage,
resource limits, secret injection and reliable time/networking. The supplied hardware has not been
benchmarked, and no claim of sufficient capacity is made yet.
