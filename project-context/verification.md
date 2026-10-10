# Verification record

Verified locally on 2026-09-17/18 with Foundry 1.5.1, Solidity 0.8.34, Node 26.3.1 and npm 11.16.0.
GitHub CI additionally runs the build and deterministic tests on Node 22 and builds the Docker image.
See the Actions run for the status of those remote checks; Docker was not running on the local host.

## Deterministic and execution tests

- TypeScript typecheck and build: pass.
- Offchain unit tests: 15 passed, 0 failed, covering quotes, gas economics, chain configuration,
  stale state, OP Stack fee-oracle errors, journal persistence, budget limits and exclusive locking.
- Solidity tests: 25 passed, 0 failed, including a 256-case input-size fuzz test, atomic loss rollback,
  partial fills, old-inventory protection, gas caps, replay, expiry, callbacks and custody permissions.
- Local Anvil integration: 1 passed. The real worker submission code simulates, estimates, signs,
  broadcasts and reconciles a transaction with ephemeral test-only funds/key. It verifies resulting
  profit, rejects observation-mode submission, and prevents duplicate submission.
- Vendored source SHA-256 verification: pass. Build inputs are recorded in
  [tested-sources.json](../evidence/tested-sources.json).

Raw output: [unit checks](../evidence/unit-checks.txt),
[offchain execution](../evidence/offchain-execution.txt).

## Mainnet fork execution

24 cases passed across eight chain/venue combinations on six chains. Each combination proves:
Aqua0 then external profit, external then Aqua0 profit, and an impossible profit requirement reverting
both legs and the Aqua0 authorization nonce. Block hashes are in each JSON report.

| Chain             | External venue | Pinned RPC block | Cases passed | Executor-call gas range | Evidence                                               |
| ----------------- | -------------- | ---------------- | ------------ | ----------------------- | ------------------------------------------------------ |
| Arbitrum (42161)  | sushi-v3       | 506302987        | 3 / 3        | 1,053,998–1,062,582     | [report](../evidence/fork-42161-506302987-venue1.json) |
| Arbitrum (42161)  | uniswap-v3     | 506302985        | 3 / 3        | 1,053,916–1,054,010     | [report](../evidence/fork-42161-506302985-venue0.json) |
| Avalanche (43114) | uniswap-v3     | 95516702         | 3 / 3        | 1,051,227–1,051,919     | [report](../evidence/fork-43114-95516702-venue0.json)  |
| Base (8453)       | sushi-v3       | 51434634         | 3 / 3        | 1,042,128–1,080,697     | [report](../evidence/fork-8453-51434634-venue1.json)   |
| Base (8453)       | uniswap-v3     | 51424327         | 3 / 3        | 1,034,391–1,042,089     | [report](../evidence/fork-8453-51424327-venue0.json)   |
| Monad (143)       | uniswap-v3     | 105639937        | 3 / 3        | 1,049,567–1,051,114     | [report](../evidence/fork-143-105639937-venue0.json)   |
| Polygon (137)     | uniswap-v3     | 93997236         | 3 / 3        | 1,038,726–1,040,546     | [report](../evidence/fork-137-93997236-venue0.json)    |
| Robinhood (4663)  | uniswap-v3     | 65891654         | 3 / 3        | 1,061,079–1,065,868     | [report](../evidence/fork-4663-65891654-venue0.json)   |

The logged `executionGas` measures the executor call in this fixture; it excludes transaction intrinsic
gas and separate rollup charges. It is not a universal gas estimate. Production submission estimates
the actual calldata and enforces the configured limit. Arbitrum logs the EVM block number in the
Solidity test; the JSON report records the different RPC height used to create the fork.

These forks use real deployed ERC20s, V3 pools, PoolManager, UniversalRouter and Permit2. They instantiate
unmodified Aqua0 vault/adapter source locally, create signed JIT payloads with test-only keys, seed
local vault backing, and deliberately shift the local Aqua0 price relative to the external pool.
Settlement and vault custody are asserted. This proves the execution path and atomic rollback against
real infrastructure. It does not prove live profitability, live LP participation, production API
credentials, or the configuration of every currently deployed Aqua0 vault.

## Live discovery and limitations

The [seven-chain discovery](../evidence/live-discovery.txt), subsequent
[Base check through PublicNode](../evidence/base-discovery-publicnode.txt) and
[Celo check](../evidence/celo-discovery.txt) validate chain IDs, contract bytecode, router/hook
PoolManager bindings and active external pools. Base/Celo initially hit public RPC errors; those
failures remain in the raw reports. Celo's configured pair returned no active supported external pool,
so Celo has discovery coverage but no successful execution-fork claim.

Historical replay on Arbitrum, Polygon and Robinhood subsequently hit pruned state. Failed historical
reports are retained alongside successful runs at freshly pinned blocks. An archive provider is needed
to replay older blocks reliably. The corrected Monad fixture's earlier failure is also retained and
explained in [debugging findings](debugging-issues.md).

Base's OP Stack `getOperatorFee(1800000)` was checked read-only and returned zero at observation time.
The fee adapter tests prove both fee components and failure behavior; they do not freeze future fees.

No mainnet deployment, trade, funding, backend authorization reservation, AWS change or Kubernetes
installation was performed. Current execution adapters cover Aqua0 V4 and Uniswap/Sushi-compatible V3;
other DEX interfaces need their own adapters and evidence. Service identity, real class/market risk
settings, long-running observation and production activation remain in the runbook.

## Source provenance

Aqua0 test source: contracts commit `42546e5c5eee94d4c0b25448911efaba33c08d86`, with per-file hashes
in `vendor/aqua0/provenance.json`. Backend API/planner review used the adjacent backend checkout at
commit `f8b77c77`; these are source-contract checks, not a live authenticated API test.

External addresses came from the official [Uniswap deployment feed](https://developers.uniswap.org/deployments.json)
and [Sushi V3 configuration](https://github.com/sushi-labs/sushi/blob/75a24ff319c5738326e549069f13fe29145539d7/src/evm/config/features/sushiswap-v3.ts).
The registry retains source provenance and onchain checks independently verify the deployed bindings.
