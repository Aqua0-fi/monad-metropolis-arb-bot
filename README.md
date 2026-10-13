# Aqua0 market rebalancer on Monad

**Monad Metropolis submission.** A `market-rebalancer-service` that keeps Aqua0's Uniswap V4 pools on Monad in
line with the rest of the market: it finds price gaps between an Aqua0 pool and an external Uniswap V3 pool,
and closes them with one atomic, profit-checked transaction.

It is live on Monad mainnet. First fill:
[`0xefc26dd8…3e00`](https://monadscan.com/tx/0xefc26dd8b02aa245bdd58ccf0d0f06952d3c3bf66043eb80e7ea72da80fc3e00)
took the EURW/USDC pool from 1.70 back to 1.1375 USDC per EURW (Uniswap was at 1.1195) and returned
**+2.71 USDC** on a 15 USDC float, for about 0.2 MON of gas.

## What Aqua0 is

Aqua0 LPs keep their capital in shared asset vaults and commit a price range to a pool. Nothing sits in the
pool itself. Each swap carries a backend-signed EIP-712 payload; the Aqua0 V4 hook injects the committed
liquidity just in time at the pool's live price, the swap runs through it, and the hook removes it and settles
with the vaults in the same transaction.

The hook deployed for this submission does not move the pool to an oracle price before each swap. An Aqua0
pool's price therefore only changes when someone trades it, and it drifts away from the market as the market
moves. That gap is what this service closes.

## What is deployed on Monad (chain 143)

|                                                   | Address                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Aqua0 V4 hook (no recentre)                       | [`0x458A6eEb541478E714A0C2D17cB02B2E4ff7a8C0`](https://monadscan.com/address/0x458A6eEb541478E714A0C2D17cB02B2E4ff7a8C0) |
| EURW/USDC pool on the hook, 0.01%, tick spacing 1 | pool id `0x1c7ae2daab59d2d45f24008b0ac194702c6707d7b89a3cf31ae5de2b04479081`                                             |
| Aqua0 EURW vault                                  | [`0xF646c4bf860Bc46d4a44FA559b04fD9585D75Fbc`](https://monadscan.com/address/0xF646c4bf860Bc46d4a44FA559b04fD9585D75Fbc) |
| Aqua0 USDC vault                                  | [`0xb367A4306087d3981B38C032464cD7E3A7a03A4E`](https://monadscan.com/address/0xb367A4306087d3981B38C032464cD7E3A7a03A4E) |
| External market: Uniswap V3 EURW/USDC 0.01%       | [`0xe153201e40F50EBc9DA7Be3AA9C419f185C97F44`](https://monadscan.com/address/0xe153201e40F50EBc9DA7Be3AA9C419f185C97F44) |
| Executor (`MarketRebalancer`)                     | [`0x76Acf30CE2dB2B0ca7A15094405448690d4efD11`](https://monadscan.com/address/0x76Acf30CE2dB2B0ca7A15094405448690d4efD11) |
| Bot wallet (owner and operator, an AWS KMS key)   | `0xd1fC4c8631E8C5d23a0C86D5890802DD70Cb4cf5`                                                                             |

For the demo, the EURW/USDC pool was deliberately opened at 1.70 USDC per EURW against a market of about 1.12,
backed by 15 USDC and 13.4 EURW of LP. The bot found the gap on its own and traded it back.

## How it works

1. **Free screen, every block.** The service reads the Aqua0 pool's price from Uniswap's `StateView` and the
   external pool's `slot0`, and estimates the round trip in both directions after fees, gas and a margin. This
   costs only free RPC reads; the Aqua0 backend is not called.
2. **One backend quote per scan.** Only when the screen shows a profitable gap does it ask the Aqua0 backend for
   a quote, for the widest gap. If the LPs can back only part of the size, it retries at the backed size.
3. **Signed authorization, then one transaction.** It asks the backend to sign the JIT authorization, simulates
   the full call, prices gas the way Monad charges it, and sends one transaction to the executor.
4. **Atomic, profit-checked execution.** `MarketRebalancer` runs both legs in one transaction (here: buy EURW on
   Uniswap V3, sell it into the Aqua0 pool through the Universal Router) and reverts unless it ends with at
   least its starting balance plus the minimum profit.

```
StateView + V3 slot0 ──► free screen ──gap?──► backend quote ──► signed JIT authorization
                                                                         │
            Uniswap V3 pool ◄── leg 1 ── MarketRebalancer.execute() ── leg 2 ──► Aqua0 V4 hook pool
                                         (one tx, reverts without profit)
```

## Built for Monad

- **Gas is charged on the gas limit, not gas used.** The service measures each call and sets a tight limit (a
  10% buffer), and counts the full limit as the cost when deciding whether a trade is worth it.
- **The RPC head trails the tip.** The first live trade reverted with `Expired()`: it was stamped at the RPC's
  head block and landed 8 blocks later, past a 5-block validity window. The executor's window is now settable
  by the owner (30 blocks on Monad, about 12 seconds) and the service's slack is set per chain. The next attempt
  filled.
- **400 ms blocks.** Scanning is driven by new block headers, and a scan's free screen takes a few milliseconds.
- **Free public RPCs only.** The service reads Monad through `rpc2.monad.xyz`; the demo backend uses
  `rpc2.monad.xyz` and `rpc-mainnet.monadinfra.com`. No paid RPC is used anywhere in this path.

## Safety and cost controls

On chain, in `MarketRebalancer`:

- Every trade must end in profit in the base token, or the whole transaction reverts.
- Only owner-allowlisted pools, a per-token input cap (20 USDC here) and a gas price cap.
- A trading window of at most 24 hours (`activeUntil`), plus a pause switch.
- A block window and replay protection on every trade.

In the service:

- Persistent per-minute, per-hour and per-day caps on backend quotes and signatures. They survive restarts.
- An "unchanged market" memo, so the backend is never asked twice about the same state.
- A daily gas cap and a maximum runtime.
- A loss latch: any trade that loses money (including a revert's gas) pauses the chain until an operator
  reviews it. It fired after the first `Expired()` revert and was cleared through the review in the Aqua0 admin
  dashboard.

The service reports its status, fills, pause state and economic reviews to Aqua0's admin rebalancer dashboard
through an authenticated report API.

## Repository layout

| Path                                          | What                                                     |
| --------------------------------------------- | -------------------------------------------------------- |
| `contracts/src/MarketRebalancer.sol`          | The executor contract                                    |
| `src/runner.ts`, `src/v4-screen.ts`           | Scan loop and the free pool-state screen                 |
| `src/aqua.ts`, `src/backend-budget.ts`        | Aqua0 backend client and its persistent call budget      |
| `src/execution.ts`, `src/live-fees.ts`        | Simulation, Monad gas pricing and submission             |
| `src/reporting.ts`, `src/history.ts`          | Dashboard report API, fill history and the loss latch    |
| `config/chains.json`                          | Monad registry: hook, pools, external venues, gas model  |
| `config/monad-v4-pilot.json`                  | Execute config template for Monad                        |
| `ops/monad-pilot.sh`                          | Deploy, configure, check, run and close the executor     |
| `ops/monad-lp.sh`, `ops/monad-trader-swap.sh` | Add or remove LP, and make a demo swap on the Aqua0 pool |
| `test/`, `contracts/test/`                    | TypeScript and Foundry tests                             |

## Running it

Requires Node 22, Foundry, an AWS KMS key for the bot wallet, and an Aqua0 backend URL with read and operator
API keys.

```bash
npm ci
npm run check                     # registry, typecheck, unit tests, contract tests
AQUA0_HOOK=0x458A6eEb541478E714A0C2D17cB02B2E4ff7a8C0 ops/monad-pilot.sh deploy   # executor, paused
AQUA0_HOOK=0x458A6eEb541478E714A0C2D17cB02B2E4ff7a8C0 ops/monad-pilot.sh setup    # allowlists, limits
AQUA0_HOOK=0x458A6eEb541478E714A0C2D17cB02B2E4ff7a8C0 ops/monad-pilot.sh run 10   # open a 10-minute window, run, close
ops/monad-pilot.sh close          # pause and close the window now
```

`run` always pauses the executor and closes its trading window on exit. Funding the executor is a manual USDC
transfer by the owner.
