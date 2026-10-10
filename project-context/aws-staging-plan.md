# KMS, public V4 discovery and staging deployment

## Authorized scope

The user authorized a dedicated KMS worker key and restricted AWS API credentials, KMS signing support,
V4 pair discovery and admin approvals, an isolated deployment on the existing AWS host, and integration
of all current staging work into the staging deployment. Main/production changes, wallet funding,
onchain executor deployment, and funded live trading are not part of this activation.

The dedicated key is recorded only in the owner's local secrets directory. The blockchain key stays
inside KMS. No key material, API credential or authenticated RPC URL belongs in this repository.

## Preserve current work

The prior uncommitted implementation was backed up before fetching. The backend and web worktrees
were fast-forwarded onto current upstream staging without overlapping local edits. This preserves the
user's and Yudhish's staging commits rather than replacing them with an older checkout. Original
checkouts remain untouched. Recheck upstream before push and do not force-push.

## Public access boundary

Price discovery uses the ordinary read-tier V4 pool and quote endpoints and public chain reads. The
worker receives no backend database, private pending-order feed or master operator/admin API key.
A quote is a read; a JIT authorization reserves backing and produces a signature. Normal execution
requires the same trader identity and eligibility gates as other users. A broad backend operator key
is not a shortcut for authenticating this service. Live trader-auth provisioning remains an explicit
release gate unless a correctly scoped normal-user path is implemented and proven.

The admin monitoring/control plane is separate: it reads the worker's own history, publishes its own
risk configuration and may display historical backing records. Its data does not supply privileged
market information to the trade-selection loop. Changing a worker policy is not an onchain grant.

## Implementation sequence

1. Add a narrow KMS transaction-account adapter. Pin expected key ARN, region and wallet address;
   verify secp256k1 SIGN_VERIFY metadata and the public address. Sign already-hashed transaction
   digests, normalize DER/low-s/recovery, and preserve the exact pending-transaction journal flow.
   Never fall back from KMS to a raw key. Retain explicit local-key support only for existing local
   tests/configurations. Observe mode must not sign or need a funded wallet.
2. Verify actual serialization against a local test signer, high-s and invalid-signature behavior,
   key/address mismatch, chain-ID binding and the existing atomic execution integration. Use a
   harmless, domain-separated live KMS test message to prove the provisioned signing path; do not
   send a blockchain transaction.
3. Poll the ordinary V4 pool listing per chain. Validate response chain, key hash, current adapter,
   tokens, arming and class identity. Store discovery and failure freshness explicitly. A new pair
   becomes visible automatically but not approved automatically. A failed/partial listing cannot
   silently erase approved records or make stale markets tradable.
4. Persist approvals and per-pair sample sizes/input/profit limits with optimistic version checks
   and an audit trail. Keep global execution disabled. Newly discovered pools still require the
   regular executor/router/token/fee/depth checks, configured supported external venues and actual
   onchain owner grants before trade execution.
5. Add the Rebalancer admin panel to the existing protected admin surface. Discovery, approval,
   disable and risk edits use server-side admin actions and a separate narrowly scoped control
   credential. Existing read-report credentials must not gain mutation authority. No endpoint can
   deploy, fund, unpause or bypass a quote/simulation through this panel.
6. Build an isolated worker image and run it on the existing AWS machine with a dedicated persistent
   directory, bounded CPU/memory/PIDs and private authenticated reporting. Do not restart existing
   services, replace the EC2 instance profile, widen another service's KMS access, or expose secrets
   via Docker inspection/logging. Verify readiness honestly even when public API access is blocked.
7. Build the backend Linux native module/image; run feature, safety and regression checks against
   the updated staging baseline. Integrate and push only approved staging branches. Verify Railway's
   actual source revision, successful deployment and staging URL, not just the existence of a push.
8. Record what is deployed, what is discovered/approved, and what still blocks funded live trading.
   SwapVM execution is explicitly deferred to the next task.

## Deployment safety

The existing EC2 host runs unrelated Aqua0, ETHGlobal and Jitsi workloads. The initial sample shows
available RAM/disk and low load, but it is not a sustained capacity proof. Capture before/after process
and container identity, bind only an unused port, cap the new worker and preserve rollback to its
previous version. Keep its credentials scoped to its new KMS key; do not copy the root session.

Any public reporting exposure needs authenticated TLS and exact routing. Additive proxy changes must
pass configuration validation before a graceful reload. Do not replace existing domains/routes or
publish a Docker daemon/SSH private key. Staging controls remain behind the existing admin gate.

## Acceptance

- Existing staging commits and all pre-existing local source are preserved.
- KMS account matches its configured wallet and correctly signs a test digest/transaction format.
- Observe mode cannot submit or reserve JIT backing.
- A newly listed, valid V4 pair appears without editing the static registry; it remains unapproved.
- Only authenticated admin actions can change versioned worker policy; report credentials cannot.
- Read errors, stale discovery and missing permissions produce visible blockers, not fabricated zeroes.
- A resource-limited worker is running on AWS with persistent history and no changes to other services.
- Staging serves the intended merged source and panel. No production/main or live funds changed.
