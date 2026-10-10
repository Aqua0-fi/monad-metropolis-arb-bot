# Staging rollout checkpoint

## Latest deployment record

The 2026-09-26 reactive release supersedes the earlier checkpoints below. Exact current revisions,
image identity, successful Railway deployments and protected UI verification are recorded in
`evidence/releases/reactive-loop/release.json` and `project-context/reactive-loop-plan.md`.
The older dated entries are retained as history, not instructions to replay an already-completed
configuration or deployment. The bot remains observe-only; a staging update does not authorize
funding, new pair permissions or live trading.

## Scope

Continue the owner-authorized observer deployment and staging admin integration. Do not deploy or
fund an onchain executor, enable transaction submission, change production/main, or approve markets
as a side effect of verifying the dashboard.

## Verified during the 2026-09-25 continuation

- Reattached to the existing Satoshi identity. Needle message acknowledgements now work.
- Read the owner's successful staging variable configuration. Did not rerun it or print its values.
- The worker's project-domain TLS endpoint returns 401 without the reporting credential and 200 with
  it. The authenticated status reports observe mode, mainnet data, eight chain rows and zero submitted
  transactions. The market catalog contains 20 discovered pools. Public `/health` is not exposed by
  this proxy; use the authenticated status endpoint rather than interpreting its 404 as a dead worker.
- The observer configuration has no execution entries. No trading funds were added in this session.
- Both application branches include their latest upstream staging commits. The backend base is
  `05078e3f3b2d9397df9cf1955c7242909130b6a8`; the frontend base is
  `01b7720c3640daa5daf5daee777dd0d0c020cb15`.
- The existing staging deployments still served those bases when inspected. They did not yet contain
  the Rebalancer panel or backend integration.

## Earlier publication checkpoint (historical)

- Backend PR 578 in Aqua0-fi/backend, base staging, head `feat/rebalancer-parity-attribution`.
  Current head at this checkpoint: `9fc3da3b1a9cb451ccd3d5afe76082c7d219a616`.
- Frontend PR 603 in Aqua0-fi/web-app, base staging, same branch name.
  Current head at this checkpoint: `77facc0dbb8e857c9615b4f9b73b52e80df01651`.
- A clean Linux checkout needs the Rust addon before importing the API. The CI build now reuses the
  deployment Dockerfile's v4-native target, verifies the built module can load, uses unique cleanup
  names, and does not install a toolchain on the shared host. Cargo build concurrency is bounded.
- The native package's Turbo task cannot restore an incompatible cached native binary. The Docker
  build selector is explicitly passed through its environment.
- Twenty-four inherited TypeScript formatting edits were compared after canonicalizing emitted
  JavaScript. Their programs were unchanged.
- Native checks and 49 focused API/planner/administration checks passed locally. The full local
  Bun 1.3 batch still has five previously documented shared-mock failures. The Linux CI Bun 1.2.20
  zero-failure gate is unchanged and remains required; do not label a local nonzero exit a full pass.
- The frontend scan found older staging identifiers, not changes introduced by the panel. Seven
  reviewed historical matches received exact commit/file/rule/line fingerprints, following the
  repository's existing policy. These cover a browser-storage namespace, a public strategy hash,
  transaction-lifetime fixtures, a token-address fixture, and a list of UI state labels. No rule or
  general path was disabled. The full local scan then passed. The updated CI scan still needs its
  own result; do not assume it is equivalent to the local scan.

## Earlier rollout steps (completed for the 2026-09-25 release)

1. Finish all current PR checks. Read failure logs and correct actual issues without waiving gates.
2. Refresh staging refs. Preserve any new teammate commits and confirm both PR bases remain staging.
3. Merge only after the checked heads pass. Verify Railway deployment revision and SUCCESS for the
   exact staging backend and web services; a GitHub push is not deployment proof.
4. Verify the protected panel at `staging-app.aqua0.xyz/admin?section=market-rebalancer`, including
   authenticated catalog reads, no live execution, and unauthenticated refusal. Do not submit an
   approval merely to demonstrate the controls.
5. Record final deployed revisions, remaining trading prerequisites and rollback references.

## Evidence locations

Session logs and backups are under
`~/.needle_mac_mcp/backups/rebalancer-staging-resume-20260925/` with private permissions. Scanner
reports are redacted. The earlier owner-run configuration, build and AWS observer proofs remain in
`evidence/parity/`. Credentials remain only in the owner's separate secrets directory, not here.

## Final deployment result

Both pull requests were merged normally into staging on 2026-09-25, without a GitHub protection
override. The latest teammate Solana transfer-fee fix was included before merging the backend.
The owner asked to stop holding the staging merge behind the shared CI queue. Therefore the
entire CI suite is NOT claimed passed: those jobs were still pending at this checkpoint.

Railway independently built and successfully deployed both exact merged revisions:

- Backend: `07f9e63382788d42d2bef3ba3a7c6573a35ee364`, deployment
  `f372917a-9fc3-4716-9efa-cb80707faa5e`.
- Frontend: `cb9cf9dad150b160bc7048749be2d47fd5314475`, deployment
  `90cca34f-de0d-4809-b737-1cdb9f5a7f2d`.

The actual admin hostname in the latest staging code is `staging-admin.aqua0.xyz`, not the public
app host. The verified page is `https://staging-admin.aqua0.xyz/?section=market-rebalancer`.
An unauthenticated request returned the existing Admin login challenge. A read-only browser check
using the existing staging admin login returned HTTP 200 and loaded host health, 20 discovered
pools, 0 approved pairs, 0 execution records and Observe only. All browser write requests were
blocked during verification. No policy was approved and no funds moved.

The screenshot is in the sibling web-app's `test-results/staging-rebalancer-live.png`; the non-secret
results are `evidence/parity/staging-live-panel.json` and `staging-rollout-result.json`.

The native addon was also built and loaded on Linux during CI. Its initial type-gate failure was
one already-fixed JIT fixture error still listed in the baseline; that single stale entry was
removed, without adding error headroom. The final three frontend scan matches were exact older
revisions of the previously reviewed storage-namespace and transaction-lifetime fixtures. Their
source was verified at the flagged commit IDs, and only exact fingerprints were added.

Trading prerequisites remain separate: an onchain executor, explicit limits and grants, operating
funding, and explicit execution enablement. SwapVM execution is not implemented in this worker.

### Post-rollout CI observation

The final frontend CodeQL and secret scan succeeded. The frontend CI job 108169134977 passed
typechecking, then stopped at the same five existing lint errors in
`components/create/venue/v4-adapter.tsx` and `components/strategies/v4-detail-view.tsx`.
A direct diff confirms neither file was changed by this feature. No lint rule was disabled and no
unrelated strategy UI rewrite was added to this rollout. The actual Railway build and protected
live-page verification remain successful. The backend staging run 36165135005 was cancelled
before running jobs; this is not a validation pass.
