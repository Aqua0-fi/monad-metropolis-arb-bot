#!/usr/bin/env bash
# Monad pilot LP: back the Aqua0 WMON/USDC pool (no-recentre hook) from YOUR wallet, or take it back out.
# Deposits into the WMON and USDC asset vaults and commits both to the pool's strategy over the full range. The
# hook injects that liquidity just in time on each authorized swap; nothing rests in the pool.
#
#   ops/monad-lp.sh add <USDC> <WMON> <wallet flags>   e.g. add 100 4125 --account me   (wraps MON if WMON is short)
#   ops/monad-lp.sh remove <wallet flags>              clear both commitments and withdraw everything free
#   ops/monad-lp.sh show <address>
set -euo pipefail

RPC=${MONAD_RPC:-https://rpc2.monad.xyz}
WMON=0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A
USDC=0x754704Bc059F8C67012fEd69BC8A327a5aafb603
WMON_VAULT=0x6274631E9C96cB68C2E8a1132513Ca3c8232072c
USDC_VAULT=0xb367A4306087d3981B38C032464cD7E3A7a03A4E
SID=39600677351958999447736613570343852438939523129701017792115048576485742086482
LO=-887270
HI=887270

num() { awk '{print $1}'; }
tx() { cast send "$@" --rpc-url "$RPC" "${W[@]}" >/dev/null; }
show() {
  local lp=$1 v
  for v in "USDC $USDC_VAULT" "WMON $WMON_VAULT"; do
    set -- $v
    echo "$1 vault: free $(cast call $2 'freePrincipal(address)(uint256)' "$lp" --rpc-url "$RPC" | num)" \
      "committed $(cast call $2 'commitments(uint256,address,uint8)(uint256,int24,int24)' $SID "$lp" 0 --rpc-url "$RPC" | tr '\n' ' ')" \
      "pool total $(cast call $2 'committedBacking(uint256)(uint256)' $SID --rpc-url "$RPC" | num)"
  done
}

case "${1:-}" in
add)
  usdc=${2:?USDC amount}
  wmon=${3:?WMON amount}
  shift 3
  W=("$@")
  ((${#W[@]} > 0)) || { echo "pass your wallet flags, e.g. --account <name> or --ledger" >&2; exit 1; }
  u=$(python3 -I -c "import sys;print(int(round(float(sys.argv[1])*10**6)))" "$usdc")
  m=$(cast to-wei "$wmon")
  lp=$(cast wallet address "${W[@]}")
  short=$(python3 -I -c "import sys;print(max(0,int(sys.argv[1])-int(sys.argv[2])))" "$m" \
    "$(cast call $WMON 'balanceOf(address)(uint256)' "$lp" --rpc-url "$RPC" | num)")
  if [[ "$short" != 0 ]]; then
    echo "wrapping $(cast from-wei "$short") MON"
    tx $WMON 'deposit()' --value "$short"
  fi
  echo "LP $lp: $usdc USDC + $wmon WMON, full range"
  tx $USDC 'approve(address,uint256)' $USDC_VAULT "$u"
  tx $USDC_VAULT 'deposit(uint256,address)' "$u" "$lp"
  tx $USDC_VAULT 'setCommitment(uint256,uint8,uint256,int24,int24)' $SID 0 "$u" $LO $HI
  tx $WMON 'approve(address,uint256)' $WMON_VAULT "$m"
  tx $WMON_VAULT 'deposit(uint256,address)' "$m" "$lp"
  tx $WMON_VAULT 'setCommitment(uint256,uint8,uint256,int24,int24)' $SID 0 "$m" $LO $HI
  show "$lp"
  ;;
remove)
  shift
  W=("$@")
  ((${#W[@]} > 0)) || { echo "pass your wallet flags, e.g. --account <name> or --ledger" >&2; exit 1; }
  lp=$(cast wallet address "${W[@]}")
  for v in $USDC_VAULT $WMON_VAULT; do
    tx $v 'setCommitment(uint256,uint8,uint256,int24,int24)' $SID 0 0 0 0
    free=$(cast call $v 'freePrincipal(address)(uint256)' "$lp" --rpc-url "$RPC" | num)
    [[ "$free" == 0 ]] || tx $v 'withdraw(uint256,address,address)' "$free" "$lp" "$lp"
  done
  show "$lp"
  ;;
show) show "${2:?address}" ;;
*) sed -n 2,8p "$0"; exit 1 ;;
esac
