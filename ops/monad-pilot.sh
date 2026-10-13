#!/usr/bin/env bash
# market-rebalancer-service Monad pilot, owner side. The owner is the KMS wallet; every write is signed
# by AWS KMS through Foundry (`--aws`). Nothing here moves tokens: funding the executor is a manual
# USDC transfer by the owner.
#
#   ops/monad-pilot.sh deploy            deploy the executor (paused, trading window closed)
#   ops/monad-pilot.sh setup             operator, limits, gas cap, allowlist the Aqua0 pool + external pools
#   ops/monad-pilot.sh status            read-only state
#   ops/monad-pilot.sh run <minutes>     open the window, run the worker, ALWAYS pause + close afterwards
#   ops/monad-pilot.sh close             pause + close the window now
set -euo pipefail
cd "$(dirname "$0")/.."

SECRETS=${SECRETS:-/Users/rithikkumars/CodingStuff/Aqua0/secrets}
RPC=${MONAD_RPC:-https://rpc2.monad.xyz} # free RPC only; the paid RPC_URL_MAINNET_MONAD is never used
STATE=runtime/monad-pilot
mkdir -p "$STATE"

OWNER=0xd1fC4c8631E8C5d23a0C86D5890802DD70Cb4cf5
UR=0x0D97Dc33264bfC1c226207428A79b26757fb9dc3
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
USDC=0x754704Bc059F8C67012fEd69BC8A327a5aafb603
WMON=0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A
HOOK=${AQUA0_HOOK:?set AQUA0_HOOK to the deployed no-recentre V4 hook}
POOL_KEY="($WMON,$USDC,500,10,$HOOK)"
EXTERNAL_POOLS=(
  0x5Bc39A29EA5d8315263EC8939d6AD393dEbC34E9 # Uniswap V3 0.05%
  0x659bD0BC4167BA25c62E05656F78043E7eD4a9da # Uniswap V3 0.3%
  0xC33e9E441e6f4E74CdB34f878bE51189C9CB00D8 # Uniswap V3 1%
  0x63e48B725540A3Db24ACF6682a29f877808C53F2 # PancakeSwap V3 0.05%
  0x85717A98d195c9306BBf7c9523Ba71F044Fea0f7 # PancakeSwap V3 0.25%
  0xB9897986847472Cd08B9A0E7BCd31EA4F1322361 # PancakeSwap V3 1%
)
MAX_INPUT=${MAX_INPUT:-20000000} # 20 USDC
MIN_PROFIT=${MIN_PROFIT:-1000}   # 0.001 USDC, onchain floor; the worker also nets out measured gas
MAX_GAS_PRICE=200000000000       # 200 gwei (Monad base fee floor is 100 gwei)

# KMS credentials for the dedicated rebalancer key only. Values are never printed.
set -a
# shellcheck disable=SC1091
source "$SECRETS/market-rebalancer.aws.env"
set +a
export AWS_KMS_KEY_ID=$MARKET_REBALANCER_KMS_KEY_ID
unset RPC_URL_MAINNET_MONAD

[[ "$(cast chain-id --rpc-url "$RPC")" == 143 ]] || { echo "RPC is not Monad" >&2; exit 1; }
EXECUTOR=$(cat "$STATE/executor" 2>/dev/null || true)
need_executor() { [[ -n "$EXECUTOR" ]] || { echo "no executor yet: run deploy" >&2; exit 1; }; }
send() { cast send --aws --rpc-url "$RPC" "$EXECUTOR" "$@" >/dev/null; }
read_() { cast call --rpc-url "$RPC" "$EXECUTOR" "$@"; }

close_window() {
  need_executor
  echo "closing: pause + trading window to 0"
  send "setPaused(bool)" true || true
  send "setActiveUntil(uint64)" 0 || true
  local p a
  p=$(read_ "paused()(bool)"); a=$(read_ "activeUntil()(uint64)")
  echo "paused=$p activeUntil=$a"
  [[ "$p" == true && "$a" == 0 ]] || { echo "CLOSE NOT CONFIRMED - rerun: $0 close" >&2; return 1; }
}

case "${1:-status}" in
deploy)
  [[ -z "$EXECUTOR" ]] || { echo "executor already deployed: $EXECUTOR" >&2; exit 1; }
  forge build >/dev/null
  out=$(forge create contracts/src/MarketRebalancer.sol:MarketRebalancer --aws --rpc-url "$RPC" --broadcast \
    --constructor-args "$OWNER" "$UR" "$PERMIT2" "$HOOK" false)
  addr=$(grep -oE "Deployed to: 0x[0-9a-fA-F]{40}" <<<"$out" | awk '{print $3}')
  [[ -n "$addr" ]] || { echo "$out" >&2; exit 1; }
  echo "$addr" >"$STATE/executor"
  echo "executor $addr (paused, window closed)"
  ;;
setup)
  need_executor
  send "setOperator(address,bool)" "$OWNER" true
  send "setLimits(address,uint256,uint256)" "$USDC" "$MAX_INPUT" "$MIN_PROFIT"
  send "setGasPriceLimit(uint256)" "$MAX_GAS_PRICE"
  send "setAquaPool((address,address,uint24,int24,address),bool)" "$POOL_KEY" true
  for p in "${EXTERNAL_POOLS[@]}"; do send "setV3Pool(address,bool)" "$p" true; done
  echo "setup done; executor stays paused with the window closed"
  echo "fund it yourself: send USDC (<= $((MAX_INPUT / 1000000)) USDC) to $EXECUTOR on Monad"
  ;;
status)
  need_executor
  echo "executor $EXECUTOR"
  echo "paused=$(read_ "paused()(bool)") activeUntil=$(read_ "activeUntil()(uint64)") now=$(cast block --rpc-url "$RPC" -f timestamp)"
  echo "USDC=$(cast call --rpc-url "$RPC" $USDC "balanceOf(address)(uint256)" "$EXECUTOR") owner MON=$(cast balance --rpc-url "$RPC" --ether $OWNER)"
  ;;
run)
  need_executor
  minutes=${2:?minutes}
  ((minutes >= 1 && minutes <= 60)) || { echo "minutes must be 1-60" >&2; exit 1; }
  MM="$SECRETS/monad-metropolis.json" # the throwaway Monad Metropolis backend on the AWS host
  [[ -f "$MM" ]] || { echo "missing $MM" >&2; exit 1; }
  mm() { python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$MM" "$1"; }
  read -r -p "Open trading for $minutes min on $EXECUTOR? type RUN: " answer
  [[ "$answer" == RUN ]] || exit 1
  cfg="$STATE/execute.json"
  python3 -I - "$cfg" "$EXECUTOR" "$SECRETS/market-rebalancer.kms.json" <<'PY'
import json, sys
out, executor, kms = sys.argv[1:]
cfg = json.load(open("config/monad-v4-pilot.json"))
cfg.pop("_template", None)
k = json.load(open(kms))
ex = cfg["execution"]["143"]
ex.update(executor=executor, allowBroadcast=True, kms={"region": k["region"], "keyId": k["kmsKeyArn"]})
cfg["mode"] = "execute"
json.dump(cfg, open(out, "w"), indent=2)
PY
  # The backend listens on the host's localhost only; reach it through an SSH tunnel for this run.
  ssh -i "$(mm sshKey)" -o BatchMode=yes -o ExitOnForwardFailure=yes -N -L 18080:127.0.0.1:18080 "$(mm host)" &
  tunnel=$!
  sleep 3
  # /health, not /ready: /ready also gates on Supabase, which this deployment does not have.
  curl -sf -m 5 http://127.0.0.1:18080/health >/dev/null || { kill $tunnel; echo "metropolis backend not reachable" >&2; exit 1; }
  trap 'close_window; kill $tunnel 2>/dev/null || true' EXIT INT TERM HUP
  now=$(cast block --rpc-url "$RPC" -f timestamp)
  send "setActiveUntil(uint64)" $((now + minutes * 60 + 90))
  send "setPaused(bool)" false
  echo "window open until $((now + minutes * 60 + 90)); worker starting"
  AQUA0_READ_API_KEY=$(mm AQUA0_READ_API_KEY) AQUA0_OPERATOR_API_KEY=$(mm AQUA0_OPERATOR_API_KEY) \
  REBALANCER_REPORT_PORT=${REBALANCER_REPORT_PORT:-19191} \
    timeout --kill-after=30 $((minutes * 60 + 60)) \
    node --import tsx src/cli.ts run --config "$cfg" --chain 143 --max-runtime-ms $((minutes * 60000)) || true
  ;;
close) close_window ;;
*) sed -n 2,10p "$0"; exit 1 ;;
esac
