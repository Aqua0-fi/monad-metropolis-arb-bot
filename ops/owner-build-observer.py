#!/usr/bin/env python3
"""Owner-run bounded rebuild of the new observer only. Does not start or stop any service."""
from pathlib import Path
import json, subprocess
root = Path(__file__).resolve().parent.parent
command = r'''set -eu
cd /home/ubuntu/market-rebalancer-builds/20260925-v4-kms
if sudo -n docker buildx inspect aqua0-rebalancer-build >/dev/null 2>&1; then
  echo 'The dedicated builder already exists; stop and inspect rather than modifying it.' >&2
  exit 1
fi
sudo -n docker buildx create --name aqua0-rebalancer-build --driver docker-container --driver-opt memory=1536m,cpu-quota=100000,cpu-period=100000,restart-policy=no
trap 'sudo -n docker buildx rm aqua0-rebalancer-build >/dev/null 2>&1 || true' EXIT
sudo -n docker buildx build --builder aqua0-rebalancer-build --load --tag aqua0-market-rebalancer:20260925-v4-kms-r3 --iidfile image-r3.id . > build-r3.log 2>&1 || { tail -n 30 build-r3.log; exit 1; }
printf '\nRuntime-verified image: '
cat image-r3.id
printf '\n'
sudo -n docker run --rm --network none --entrypoint node "$(cat image-r3.id)" --input-type=module -e 'import {loadChains} from "./dist/src/config.js";console.log(JSON.stringify({runtimeUser:process.getuid(),registeredChains:loadChains().length,serviceStarted:false}))'
'''
r = subprocess.run(['ssh','-i',str(Path.home()/'Downloads/AWS-Ubuntu-KP1.pem'),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','ubuntu@18.207.103.187','bash -s'], input=command, text=True, capture_output=True, timeout=600)
output = root/'evidence/parity/owner-observer-build.log'
output.write_text(r.stdout+r.stderr)
print(r.stdout)
if r.returncode:
    print(r.stderr[-1500:])
print('Build result saved:', output)
raise SystemExit(r.returncode)
