#!/usr/bin/env python3
"""Owner-run Monad V4 executor setup. Default: read-only preview, no credential loaded.

--enable (interactive, typed phrase SETUP MONAD 143) sets the operator, USDC limits, gas ceiling,
the Aqua0 V4 pool key(s) and matching external V3 pool(s), and transfers USDC from the owner wallet
into the executor only up to the funding cap. It always leaves the executor PAUSED with activeUntil = 0
and writes runtime/monad-pilot/execute.json for the timed run.
"""
import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import owner_monad_common as common  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--enable', action='store_true')
    modes.add_argument('--write-worker-config', action='store_true',
                       help='only (re)write runtime/monad-pilot/execute.json; no onchain action')
    parser.add_argument('--rpc', default=common.DEFAULT_RPC)
    parser.add_argument('--signer', choices=['kms', 'anvil-test'], default='kms')
    parser.add_argument('--state-dir')
    parser.add_argument('--test-confirm', help=argparse.SUPPRESS)  # anvil-test signer only
    parser.add_argument('--executor')
    parser.add_argument('--template')
    parser.add_argument('--max-input-usdc', help='per-trade input cap (default 5, hard cap 20)')
    parser.add_argument('--min-profit-usdc', help='onchain profit floor (default 0.001)')
    parser.add_argument('--fund-usdc', help='executor USDC funding target (default 5, hard cap 20)')
    parser.add_argument('--max-gas-gwei', help='executor gas-price ceiling (default 200, 102..500)')
    parser.add_argument('--pools', help='comma-separated pool labels (default usdc-usdt0)')
    args = parser.parse_args(argv)
    if args.enable and args.signer == 'kms':
        common.require_interactive('Owner setup')
    if args.signer == 'anvil-test' and not common.is_loopback(args.rpc):
        raise common.OwnerRefusal('The anvil-test signer only runs against http://127.0.0.1')
    if args.test_confirm is not None and args.signer != 'anvil-test':
        raise common.OwnerRefusal('--test-confirm is only accepted with the anvil-test signer')
    common.validate_rpc(args.rpc)
    env = common.scrubbed_env()
    if args.enable and args.signer == 'kms':
        env.update(common.load_aws_env())
    command = common.node_command('owner-setup-monad.ts', '--rpc', args.rpc, '--signer', args.signer)
    if args.test_confirm is not None:
        command += ['--test-confirm', args.test_confirm]
    for flag in ('state_dir', 'executor', 'template', 'max_input_usdc', 'min_profit_usdc', 'fund_usdc',
                 'max_gas_gwei', 'pools'):
        value = getattr(args, flag)
        if value is not None:
            command += ['--' + flag.replace('_', '-'), value]
    if args.enable:
        command.append('--enable')
    elif args.write_worker_config:
        command.append('--write-worker-config')
    return subprocess.run(command, cwd=common.ROOT, env=env, check=False).returncode


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, common.OwnerRefusal) as exc:
        common.fail(exc)
