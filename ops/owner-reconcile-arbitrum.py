#!/usr/bin/env python3
"""Owner-run receipt reconciliation and tested-image update for the existing Arbitrum pilot."""
import argparse
import json
import os
import re
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--transaction', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.apply:
        print('Preview only. --apply requires an interactive owner and never changes trade limits or funding.')
        return 0
    if not os.isatty(0) or not os.isatty(1):
        raise RuntimeError('Receipt repair requires the owner at an interactive terminal')
    if (not re.fullmatch('sha256:[a-f0-9]{64}', args.image) or not re.fullmatch('[a-f0-9]{40}', args.source)
            or not re.fullmatch('0x[0-9a-fA-F]{64}', args.transaction)):
        raise RuntimeError('Invalid release or transaction identity')
    print('Record this exact already-mined transaction, then resume the existing pilot on the repaired image.')
    print('The receipt-only step cannot sign or trade. Funds, limits, credentials and pauses are preserved.')
    print('If recovery fails after stopping, the worker stays stopped and all evidence is retained.')
    print('Transaction:', args.transaction)
    if input('Type RECONCILE ARBITRUM RECEIPT: ').strip() != 'RECONCILE ARBITRUM RECEIPT':
        raise RuntimeError('Confirmation did not match; no change requested')
    try:
        p = subprocess.run(['railway', 'variables', '--project', '1c3922b9-853b-47e0-9a4b-4586f98ef533',
                            '--environment', '769ac5d2-1d3c-4dcb-9a23-0d5761647daa',
                            '--service', '5bd09f99-7ec9-4d42-b52c-4da6e1f2b1c8', '--json'],
                           text=True, capture_output=True, timeout=30)
        if p.returncode:
            raise RuntimeError()
        rpc = json.loads(p.stdout)['RPC_URL_MAINNET_ARBITRUM']
        if not isinstance(rpc, str) or not rpc.startswith('https://'):
            raise RuntimeError()
    except (ValueError, KeyError, RuntimeError):
        raise RuntimeError('The existing backend mainnet RPC configuration could not be read; no host changes requested')
    request = {'confirmed': True, 'image': args.image, 'source': args.source,
               'transaction': args.transaction, 'rpcUrl': rpc}
    code = Path(__file__).with_name('owner-reconcile-remote.py').read_text()
    code += '\ntry:\n print(json.dumps(main(' + repr(request) + '),indent=2))\nexcept Exception as error:\n print(json.dumps({"state":"recovery-stopped","reason":str(error)}))\n raise SystemExit(1)\n'
    result = subprocess.run(['ssh', '-i', str(Path.home() / 'Downloads/AWS-Ubuntu-KP1.pem'),
                             '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
                             'ubuntu@18.207.103.187', 'sudo -n python3 -'],
                            input=code, text=True, capture_output=True, timeout=300)
    # The authenticated RPC was passed only through encrypted stdin, never argv or files.
    if result.stdout:
        print(result.stdout.replace(rpc, '[RPC]'))
    if result.returncode:
        print('Receipt maintenance did not complete. The worker may be stopped; retain its history and journal.')
    return result.returncode


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        reason = re.sub(r'https?://\S+', '[RPC]', str(error))[:350]
        print('Owner receipt repair stopped: ' + reason + '. No successful recovery is assumed.')
        raise SystemExit(1)
