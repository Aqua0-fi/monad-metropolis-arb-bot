#!/usr/bin/env python3
"""One owner-run Arbitrum pilot entrypoint. Without --enable this only previews.

Uses the already-created, dedicated KMS credential file. It never loads ambient
administrator credentials or exports a blockchain private key.
"""
import argparse
import os
import shlex
import stat
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--enable', action='store_true')
    group.add_argument('--status', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if args.enable and (not os.isatty(0) or not os.isatty(1)):
        raise RuntimeError('Enabling requires the owner at an interactive terminal')
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(('AWS_', 'MARKET_REBALANCER_', 'REBALANCER_', 'AQUA0_', 'ETH_'))}
    if args.enable:
        source = Path('/Users/rithikkumars/CodingStuff/Aqua0/secrets/market-rebalancer.aws.env')
        info = source.lstat()
        if source.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeError('The dedicated credential file must be owner-only and mode 600')
        allowed = {'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION',
                   'MARKET_REBALANCER_KMS_KEY_ID', 'MARKET_REBALANCER_OPERATOR_ADDRESS'}
        for line in source.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            name, value = line.split('=', 1)
            if name not in allowed:
                continue
            parts = shlex.split(value)
            if len(parts) != 1 or name in env:
                raise RuntimeError('Ambiguous dedicated credential syntax')
            env[name] = parts[0]
    env.update(AWS_CONFIG_FILE='/dev/null', AWS_SHARED_CREDENTIALS_FILE='/dev/null', AWS_EC2_METADATA_DISABLED='true')
    command = ['node', '--import', 'tsx', 'scripts/owner-start-arbitrum.ts']
    if args.enable:
        command.append('--enable')
    elif args.status:
        command.append('--status')
    return subprocess.run(command, cwd=root, env=env, check=False).returncode


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as exc:
        print('Owner pilot helper stopped: ' + str(exc))
        raise SystemExit(1)
