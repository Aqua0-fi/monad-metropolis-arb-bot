# Remaining work before production activation

- Mainnet executor deployment, owner/operator addresses, funding limits, real strategy IDs and service
  API credentials are intentionally unset. No funded production-backend round trip has been attempted.
- Observe real markets long enough to measure opportunities after network and hosting costs. Seeded
  fork price gaps prove mechanics; they do not establish live profitability or demand.
- Aqua0 V4 and guarded SwapVM legs against Uniswap/Sushi-compatible V3 exact-input swaps are implemented.
  V2, Aerodrome, multi-hop and cross-chain routes still need distinct adapters and fork evidence.
- Celo's configured token pair has no discovered liquid supported external pool. Leave it idle until
  genuine executable depth exists or a separately tested venue/pair is configured.
- RPC subscriptions and backend authorization credentials require operational provisioning. Short-lived
  caller-token renewal is not an embedded authentication provider in this worker.
- Native V4 sizing and bounded actual-VM adaptive sizing replace configured sample grids. The worker
  still uses scan-then-sleep scheduling. Per-chain block/event triggers, persistent prepared-state caches,
  measured quote latency and stale-search cancellation remain throughput work. Arbitrary VM programs
  receive no false concavity or global-optimum guarantee.
- OP Stack fee oracles are required to support both `getL1Fee` and `getOperatorFee`. Unsupported
  deployments fail closed. Buffers reduce fee risk but cannot freeze inclusion-time fees or token prices.
- No external security audit, MEV/private-transport integration, multi-host leader election or automatic
  dropped-transaction replacement. Run one worker with a durable journal and dedicated account.
- The resource-limited AWS observer is deployed alongside existing services. Physical-machine/Kubernetes
  deployment remains deferred. Keep monitoring actual capacity; a point-in-time sample is not a forecast.

## Reporting and native replacement release gates

- The private report connection and persistent runtime directory already serve the deployed observer.
  Upgrades must preserve its journal, policies, credentials and rollback image. Reporting begins with
  newly captured executions and is not a fabricated historical backfill.
- Independently checked per-LP source shares require the current deployment's principal-sale event
  trail and registry vault identity. Older or incomplete trails remain unavailable.
- Build and run the backend's Linux native image/load gate on a local or authorized build engine.
  Mac native tests pass, but the local Docker daemon was unavailable for an image test.
- Review the retained upstream simulator license notices before production use/distribution.
- The full backend batch suite retains five upstream-reproduced durability/mock-state failures;
  their affected suites pass independently. The frontend has five pre-existing lint errors in two
  unchanged files. These are not hidden by the passing feature, build and differential checks.

## Verification of the native/SwapVM update

A fresh Base fork at block 51798735 passed both actual-router round-trip orders, explicit receipt
anchor checks, stale program/class refusal, output-floor rollback and full unprofitable-cycle rollback.
It uses a controlled test maker and local test funds, not the production vault adapter or real capital.
Adversarial backend tests separately verify receipt identity and exact per-LP principal totals.
The frontend full suite passed 6186 tests with 50 skipped; production build and changed-source lint
passed. Backend candidate and staging have identical normalized type-error sets; five pre-existing
combined-suite durability/mock failures were reproduced on the untouched staging reference.
