#!/usr/bin/env python3
"""Owner-run image repair of the already-funded Arbitrum pilot. Default is status only."""
import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REMOTE = ROOT / 'ops/owner-refresh-remote.py'
RECEIPT = ROOT / 'runtime/owner-launch/arbitrum-refresh-release.json'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.apply and (not os.isatty(0) or not os.isatty(1)):
        raise RuntimeError('Applying requires the owner at an interactive terminal')
    receipt = json.loads(RECEIPT.read_text())
    code = REMOTE.read_bytes()
    if hashlib.sha256(code).hexdigest() != receipt['helperSha256']:
        raise RuntimeError('Upgrade helper changed after its release checks')
    if args.apply:
        print('Update the worker image only. Keep existing 5-USDC pilot settings, funds and history.')
        print('First run an isolated read-only timing/full-call probe. Stop without updating if it fails.')
        if input('Type UPDATE ARBITRUM WORKER: ').strip() != 'UPDATE ARBITRUM WORKER':
            raise RuntimeError('Confirmation did not match; no update requested')
    request = {'action': 'apply' if args.apply else 'status', 'confirmed': args.apply,
               'probeHash': receipt['probeSha256']}
    program = code.decode() + '\ntry:\n print(json.dumps(main(' + repr(request) + '),indent=2))\nexcept Exception as e:\n print(json.dumps({"state":"stopped","error":str(e)}))\n raise SystemExit(1)\n'
    result = subprocess.run(['ssh', '-i', str(Path.home() / 'Downloads/AWS-Ubuntu-KP1.pem'),
                             '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                             '-o', 'ConnectTimeout=8', 'ubuntu@18.207.103.187', 'sudo -n python3 -'],
                            input=program, text=True, capture_output=True, timeout=300)
    if result.stdout:
        print(result.stdout)
    if result.returncode:
        print('Owner update did not complete. Keep the existing transaction journal and inspect status.')
        return result.returncode
    answer = json.loads(result.stdout)
    return 0 if answer.get('state') in ['updated', 'already-updated', 'ready-for-owner-validation'] else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print('Owner image update stopped: ' + str(exc))
        raise SystemExit(1)
