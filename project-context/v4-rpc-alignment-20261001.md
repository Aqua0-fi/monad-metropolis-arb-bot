# Uniswap V4 RPC alignment repair - 2026-10-01

## Observed failure and scope

Read-only inspection of the active Arbitrum worker found fresh USDC/DAI V4 candidates followed by `Stale or reorged candidate` or `BlockNotFoundError`, then a chain-error backoff. One observed quote was at RPC block 510676455, only 393 ms old, while the worker's separate latest-height read was 510676454. The selected-route refresh also requested its quote block before the worker RPC had caught up.

Both class-1 and class-14 live policies already used 10000 native-USDC units (0.01 USDC) minimum net profit and a 5000000-unit input cap. The executor's separate floor matched. No financial policy, contract permission, execution activation or cap needed changing. This patch changes only the Uniswap V4 validation path; it does not repair or change the Aqua/SwapVM route or the frontend dashboard.

## Repair

Initial V4 candidate selection and selected V4 re-optimization now share `verifyV4Quote`. It reuses the existing bounded `waitForRpcHead` mechanism, checks an actual latest full block, then verifies the quote's canonical block/hash. It never substitutes the quote height for observed RPC evidence. A full head at the exact quote height supplies the canonical evidence directly; otherwise the pinned quote block is read.

A typed pinned-block absence can be retried within the original quote deadline to accommodate load-balanced provider skew. Expiry, excessive block lag, future timestamps, a changed hash, stop or pause still reject. Other RPC errors are not relabeled as harmless lag. Task liveness and market approval are rechecked after waiting and before offering or authorizing a candidate.

The V4 read batch preserves transient stale/reorg error types instead of converting them into a generic failed-price-check error. Started reads are drained; the existing outer obsolete-work handler then discards and requotes without growing the minute-long failure backoff. True transport/quote failures keep their existing error path. Fee estimation, whole-transaction simulation, signing, nonce management and financial guards are unchanged.

## Verification

The three real-runner regressions failed before the patch with the observed future-quote, missing-block and false chain-error behavior. They now pass. Their RPCs are mocked; the selected-execution fixture throws a sentinel before authorization, and has no live transport or key.

- 15 new tests cover both V4 runner paths and the validator's provider-lag, pinned-block retry, missing-hash, true reorg, stale/time/block bounds, cancellation and pause cases. Together with five existing RPC-head cases, all 20 focused checks pass.
- `npm run check` passed: 180 unit tests, 47 contract cases and 18 owner-maintenance helper tests, plus registry verification, type checking and compiler-boundary checks.
- `npm run test:integration` passed all three isolated local-EVM transaction tests.
- `npm run format:check` and `npm run build` passed.
- The existing USDC/DAI V4 fork fixture passed both route orders and complete unprofitable-cycle rollback at Arbitrum RPC block 510678586, hash `0x96825be9648306833b496f888247d553c2ca7ef5579f0954af96bc8c8bbaf4c2`. It used real token/external-pool state, locally deployed Aqua0 vaults/hook and synthetic price displacement/capital. It is not proof of current live profitability or class-14 execution.

Fork evidence: `evidence/fork-42161-510678586-venue0-fork-usdc-dai-arbitrum.json`. Red/green and complete verification logs are retained in the sibling `../evidence` directory of the isolated `working-dir/v4-rpc-consistency-20261001` workspace.

## Release boundary

The worker repository's GitHub workflow runs CI and builds an image; it does not deploy the running AWS worker. Publishing or merging this patch to `staging` is not a live-runtime update. No worker restart, image-pin change, setting change, live authorization, transaction signing or mainnet transaction was performed by this repair. Any subsequent owner-approved runtime update must preserve the existing image provenance, limits, controls and persistent transaction journal, and must be verified separately.
