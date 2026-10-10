# Measured fees and the owner-run Arbitrum pilot

## Scope

This is one same-chain Aqua/SwapVM to Uniswap V3 price-arbitrage pilot on Arbitrum 42161, not
cross-chain repatriation. Existing staging price controls, LP wallets, actual receipt P&L and durable
loss pauses remain in place. A 90% LP return is a separate manual hackathon action, never an automatic
withdrawal. Trading profits remain in the executor.

## Exact owner entrypoint

```sh
python3 /Users/rithikkumars/CodingStuff/Aqua0/working-dir/rebalancer-readiness-20260928/worker-review/ops/owner-start-arbitrum.py --enable
```

The owner must type `START ARBITRUM 5 USDC` after reading the preview. Without `--enable`, the same
command is read-only and does not load a signing credential. `--status` is also read-only. The agent
must not run the enabling form. Its non-interactive refusal is tested before any credentials, RPC
operation or host mutation.

The helper refuses activation until `runtime/owner-launch/arbitrum-pilot-release.json` identifies the
actual tested image currently running on AWS. An implementation in source is not proof of rollout.
That receipt must be written from a verified observe-only release, not fabricated to bypass the gate.

Owner/operator: `0xd1fC4c8631E8C5d23a0C86D5890802DD70Cb4cf5`.
Executor, already deployed and initially paused: `0x0C527b9B1D603863CADC1CBBc1483036ac21D252`.
Native USDC: `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`.
Never send ETH directly to the executor. The existing owner wallet pays gas and can fund USDC through
an exact-output purchase; unused ETH is refunded to that same owner within the transaction.

## What the confirmed command does

The read-only preview verifies actual code, owner, immutable router bindings, native-asset identity,
external factory/quoter/pool, SwapVM maker/class and current shipped strategy. Host preflight checks the
pinned image, Arbitrum-only process, existing pauses, pending journal and market permissions. A changed
or ambiguous setting stops the helper rather than overwriting a teammate's setup.

After owner confirmation it stages only the existing restricted KMS credential in an owner-readable
file and restarts the same service in observation mode. KMS GetPublicKey verifies the wallet before
funding; it does not sign a readiness transaction. Then the owner-invoked process grants only the chosen
operator, token limits, exact V3 pool, bound VM router and stable strategy. It buys only the missing
amount needed to reach 5 native USDC in the executor. It checks the receipts and onchain configuration,
unpauses the executor, and enables only the Arbitrum worker with exactly one external pool.

The policy in `config/arbitrum-pilot.json` sets a 5-USDC maximum input, 0.01-USDC minimum net profit,
5% live gas-price margin, 2,000,000-gas ceiling, 0.05-gwei price ceiling, 0.0002-ETH daily gas budget,
0.0003-ETH cumulative setup-gas budget and 0.003-ETH maximum inventory purchase. These are explicit
owner policy caps, not measurements. The funding purchase uses an actual onchain quote plus a 1%
maximum-input allowance. Its exact output goes to the executor; profits already there do not trigger
another purchase. No flash loan, bridge, public withdrawal or LP payout is performed by setup.

## Measured transaction economics

Exploratory V4/SwapVM searches no longer subtract a fixed maximum-gas allowance and call that measured
net profit. They report gross-only candidates with fees unverified. The selected permissioned, funded
call is estimated at a known block. The worker uses the live RPC gas price with a 5% margin, the actual
estimated complete-call gas, and any applicable extra-network oracle charges. Arbitrum posting cost is
already represented by its RPC gas estimate. A real exact-output V3 quote measures the starting tokens
required to cover the native fee asset, with verified token decimals and pool/quoter/factory identity.

Changing the profit floor changes calldata, so the final call is re-estimated until its own cost is
covered. Full simulation, canonical state, nonce, latest-state signing/broadcast guards and the final
onchain balance check remain required. Fee rejection happens before signing and lets another ready
candidate compete. Unavailable fees fail closed; they are not zero. Daily exposure reservations and
actual receipt P&L have different purposes and are not substituted for one another.

## Recovery and secret handling

The helper persists an unsigned intent before signing and its deterministic transaction hash before
broadcasting. An RPC timeout, missing saved hash or failed transaction is not retried blindly. Keep
`runtime/owner-launch/arbitrum-pilot.json`; never delete it to clear an uncertain transaction. Successful
steps are independently receipt-checked before they can be skipped. The worker's journal and SQLite
history are preserved across setup and image updates, including an activation failure.

Only the existing dedicated KMS IAM credential is loaded, not an ambient administrator session. Secret
values travel over authenticated SSH input, not shell arguments or Docker environment inspection. The
runtime file is mode 600 in a mode-700 directory mounted read-only. The provider re-reads it for rotation
and refuses missing, exposed, symlinked or expired credentials. The target-bound worker signing callback only accepts complete executor `execute` calldata, and rejects
deployments, native transfers, typed approvals and owner/withdrawal calls. This is an application control,
not an AWS policy that decodes transactions: someone with the raw KMS signing credential can request
arbitrary digests. The pilot uses the owner wallet at the owner's request, so credential protection and
small funding matter; production separation of owner and operator remains advisable. The owner-call signer is separate,
one-use and bound to the exact reviewed chain, target, value, gas fields and calldata digest.

## Execution evidence and limitations

At the captured Arbitrum block 509863711, the actual deployed executor, AquaAdapter/vaults and external
pool completed an observed route on a local fork without changing either pool price: 3.976562 USDC
became 4.718717 USDC. Actual LP-debit logs identify the source wallet. An impossible-profit version
reverted all vault/VM/transaction effects. This is captured-state execution evidence, not realized
mainnet profit, a promise that the spread persists, or a gas-inclusion latency benchmark.

The helper's exact funding calldata was separately executed against the real router at fork block 509881580. It delivered exactly 5 USDC to the paused executor, consumed 0.001877546132473160 ETH before
network fees and refunded 0.000018775461324732 ETH. An impossible input cap reverted the entire funding
purchase. No real funds were moved by either local-fork proof.

The remote owner's preflight tool invocation was blocked by the tool platform and was not retried
through another transport. Its host staging/activation logic is covered by offline filesystem/API/host
fixtures, not claimed as a live owner activation test. The local default preview independently read
real chain bindings and a funding quote without a key or signature. Real activation remains owner-run.
A successful start may still wait for an opportunity; only canonical mainnet receipts establish actual
trading profit. Existing V4 consent and missing LP-preference routes remain unavailable, not force-enabled.
