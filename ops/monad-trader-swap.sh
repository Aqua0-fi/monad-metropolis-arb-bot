#!/usr/bin/env bash
# Monad pilot demo trader: sells WMON into the Aqua0 WMON/USDC pool, which moves that pool's price off the
# Uniswap/PancakeSwap price. That gap is what the market-rebalancer-service closes. Signed by YOUR wallet, with
# any cast wallet flags; the JIT authorization comes from the Monad Metropolis backend over an SSH tunnel.
#
#   ops/monad-trader-swap.sh <WMON amount, e.g. 100> --account <keystore> | --ledger | --interactive
#
# The backend refuses to sign once the pool is more than 5% off the market price, so keep the move under ~3%.
set -euo pipefail
cd "$(dirname "$0")/.."

amount=${1:?WMON amount, e.g. 100}
shift
(($# > 0)) || { echo "pass your wallet flags, e.g. --account <name> or --ledger" >&2; exit 1; }
W=("$@")

SECRETS=${SECRETS:-/Users/rithikkumars/CodingStuff/Aqua0/secrets}
RPC=${MONAD_RPC:-https://rpc2.monad.xyz}
WMON=0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A
USDC=0x754704Bc059F8C67012fEd69BC8A327a5aafb603
HOOK=0x458A6eEb541478E714A0C2D17cB02B2E4ff7a8C0
UR=0x0D97Dc33264bfC1c226207428A79b26757fb9dc3
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
STATE_VIEW=0x77395F3b2E73aE90843717371294fa97cC419D64
UNI_V3_30=0x659bD0BC4167BA25c62E05656F78043E7eD4a9da
PID=0x578d30680d809f6f197d16bcb72a792f57d3cb2475a01c2892bf84a29b040952
SID=39600677351958999447736613570343852438939523129701017792115048576485742086482
MIN_SQRT_PLUS_1=4295128740

MM="$SECRETS/monad-metropolis.json"
mm() { python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$MM" "$1"; }
price() { # USDC per WMON from a sqrtPriceX96
  python3 -I -c "import sys;print(round((int(sys.argv[1])/2**96)**2*1e12, 6))" "$1"
}
ours() { price "$(cast call $STATE_VIEW 'getSlot0(bytes32)(uint160,int24,uint24,uint24)' $PID --rpc-url "$RPC" | head -1 | awk '{print $1}')"; }
uni() { price "$(cast call $UNI_V3_30 'slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)' --rpc-url "$RPC" | head -1 | awk '{print $1}')"; }

amt=$(cast to-wei "$amount")
trader=$(cast wallet address "${W[@]}")
bal=$(cast call $WMON 'balanceOf(address)(uint256)' "$trader" --rpc-url "$RPC" | awk '{print $1}')
python3 -I -c "import sys;sys.exit(int(sys.argv[1]) < int(sys.argv[2]))" "$bal" "$amt" \
  || { echo "$trader holds $(cast from-wei "$bal") WMON; wrap first: cast send $WMON 'deposit()' --value ${amount}ether ..." >&2; exit 1; }

echo "trader $trader sells $amount WMON. Before: ours $(ours)  Uniswap 0.3% $(uni) USDC/WMON"
cast send $WMON 'approve(address,uint256)' $PERMIT2 "$amt" --rpc-url "$RPC" "${W[@]}" >/dev/null
cast send $PERMIT2 'approve(address,address,uint160,uint48)' $WMON $UR "$amt" $(($(date +%s) + 600)) \
  --rpc-url "$RPC" "${W[@]}" >/dev/null

ssh -i "$(mm sshKey)" -o BatchMode=yes -o ExitOnForwardFailure=yes -N -L 18080:127.0.0.1:18080 "$(mm host)" &
tunnel=$!
trap 'kill $tunnel 2>/dev/null || true' EXIT
sleep 3
body=$(printf '{"venue":"v4","chainId":143,"poolId":"%s","classId":"%s","token0":"%s","token1":"%s","fee":500,"tickSpacing":10,"swapDirection":"zeroForOne","tradeType":"exactIn","requestedAmount0":"%s","amountSpecified":"-%s","sqrtPriceLimitX96":"%s"}' \
  $PID $SID $WMON $USDC "$amt" "$amt" $MIN_SQRT_PLUS_1)
auth=$(curl -sf -m 20 http://127.0.0.1:18080/api/swap/authorize -H 'content-type: application/json' \
  -H "X-API-Key: $(mm AQUA0_READ_API_KEY)" -H "X-Operator-Key: $(mm AQUA0_OPERATOR_API_KEY)" -H 'X-Network-Mode: mainnet' \
  -d "$body") || { echo "authorize refused (no LP committed yet, or the pool is >5% off the market?)" >&2; exit 1; }
read -r hookData deadline executor < <(python3 -I -c "import json,sys;a=json.loads(sys.argv[1]);print(a['hookData'],a['authorization']['deadline'],a['authorization']['executor'])" "$auth")
[[ "$(tr A-F a-f <<<"$executor")" == "$(tr A-F a-f <<<"$UR")" ]] || { echo "authorization is not bound to the Universal Router" >&2; exit 1; }

swap=$(cast abi-encode 'f(((address,address,uint24,int24,address),bool,uint128,uint128,bytes))' \
  "(($WMON,$USDC,500,10,$HOOK),true,$amt,0,$hookData)")
settle=$(cast abi-encode 'f(address,uint256)' $WMON "$amt")
take=$(cast abi-encode 'f(address,uint256)' $USDC 0)
input=$(cast abi-encode 'f(bytes,bytes[])' 0x060c0f "[$swap,$settle,$take]")
calldata=$(cast calldata 'execute(bytes,bytes[],uint256)' 0x10 "[$input]" "$deadline")
echo "authorized; sending within the 45s window"
cast send $UR "$calldata" --rpc-url "$RPC" "${W[@]}" --json \
  | python3 -I -c "import json,sys;r=json.load(sys.stdin);print('swap', r['transactionHash'], 'status', int(r['status'],16))"
echo "After: ours $(ours)  Uniswap 0.3% $(uni) USDC/WMON"
