# Working on market-rebalancer-service

Read `project-context/agent-context.md`, `project-context/debugging-issues.md`,
`project-context/tech-debt.md`, then `project-context/how-it-works.md` before changing code.

- The service is always named `market-rebalancer-service`; the repository is
  `aqua0-market-rebalancer-service`.
- User priority: preserve scarce capital. Both swap legs and the starting-token profit guard must stay
  in one EVM transaction. Never replace a failed quote/simulation with best-effort execution.
- Reverts preserve trade principal but consume gas. Include chain-specific fees, budgets and this
  limitation in any profitability claim.
- No implicit live broadcasting. Existing mainnet deployment, funding, strategy approval, credentials
  and explicit configuration are prerequisites. The existing staging applications and AWS observe-only
  service are authorized and deployed. Their update is not permission to fund an executor, approve a
  pair, enable trading or promote production/main. Read the latest release record before a rollout.
- Never expose keys, log raw authenticated RPC URLs, copy sibling `.env` files, or use protocol signer
  keys as rebalancer operator keys.
- Do not edit `vendor/aqua0/src`. Update its exact source snapshot and provenance together if needed.
- Do not change a router tuple format from source inspection alone; prove it against that deployment
  on a pinned fork. Robinhood uses the extended exact-input tuple.
- EVM `block.number` and RPC height can differ. The onchain expiry uses `executionBlockNumber()`.
- Keep the process single-replica with persistent journal and exclusive lock. Uncertain transactions
  remain pending until reconciled; never automatically discard a pending hash.
- Run `npm run check`, `npm run test:integration`, and affected fork cases for execution changes.
  Record exact blocks, source hashes, failures and the distinction between seeded and observed state.
