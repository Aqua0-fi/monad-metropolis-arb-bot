#!/usr/bin/env python3
"""Owner-run bridge: a small amount of Arbitrum ETH from the KMS wallet to MON for the SAME wallet on Monad.

Uses Relay's public quote API (no API key). Default: read-only preview (exact source amount, destination
address and chain, expected/minimum MON, fees). --send needs an interactive terminal and the typed phrase
BRIDGE <amount> ETH TO MONAD. The amount is capped at 0.0015 ETH; any other destination is refused.
"""
import argparse
import re
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import owner_monad_common as common  # noqa: E402

MAX_ETH = Decimal('0.0015')


def validate_amount(text):
    if not re.fullmatch(r'0\.[0-9]{1,18}', text or ''):
        raise common.OwnerRefusal('--amount-eth must look like 0.001')
    value = Decimal(text)
    if value <= 0 or value > MAX_ETH:
        raise common.OwnerRefusal('--amount-eth must be > 0 and at most %s ETH' % MAX_ETH)
    return text


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--send', action='store_true')
    modes.add_argument('--status', action='store_true')
    parser.add_argument('--amount-eth', default='0.001')
    parser.add_argument('--monad-rpc', default=common.DEFAULT_RPC)
    parser.add_argument('--state-dir')
    args = parser.parse_args(argv)
    validate_amount(args.amount_eth)
    if args.send:
        common.require_interactive('Bridging')
    common.validate_rpc(args.monad_rpc)
    env = common.scrubbed_env()
    if args.send:
        env.update(common.load_aws_env())
    command = common.node_command('owner-bridge-monad.ts', '--amount-eth', args.amount_eth,
                                  '--monad-rpc', args.monad_rpc)
    if args.state_dir:
        command += ['--state-dir', args.state_dir]
    if args.send:
        command.append('--send')
    elif args.status:
        command.append('--status')
    return subprocess.run(command, cwd=common.ROOT, env=env, check=False).returncode


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, common.OwnerRefusal) as exc:
        common.fail(exc)
