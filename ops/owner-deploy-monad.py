#!/usr/bin/env python3
"""Owner-run Monad (143) executor deployment. Default: read-only preview, no credential loaded.

--send requires an interactive terminal and the typed phrase DEPLOY 143. --status never signs or resends.
The executor deploys PAUSED with activeUntil = 0 (it cannot trade until a bounded window is opened).
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
    modes.add_argument('--send', action='store_true')
    modes.add_argument('--status', action='store_true')
    parser.add_argument('--rpc', default=common.DEFAULT_RPC)
    parser.add_argument('--signer', choices=['kms', 'anvil-test'], default='kms')
    parser.add_argument('--state-dir')
    parser.add_argument('--test-confirm', help=argparse.SUPPRESS)  # anvil-test signer only
    args = parser.parse_args(argv)
    # Refusals happen before any credential file is opened or RPC is contacted.
    if args.send and args.signer == 'kms':
        common.require_interactive('Sending a Monad deployment')
    if args.signer == 'anvil-test' and not common.is_loopback(args.rpc):
        raise common.OwnerRefusal('The anvil-test signer only runs against http://127.0.0.1')
    if args.test_confirm is not None and args.signer != 'anvil-test':
        raise common.OwnerRefusal('--test-confirm is only accepted with the anvil-test signer')
    common.validate_rpc(args.rpc)
    env = common.scrubbed_env()
    if args.send and args.signer == 'kms':
        env.update(common.load_aws_env())
    command = common.node_command('owner-deploy-monad.ts', '--rpc', args.rpc, '--signer', args.signer)
    if args.state_dir:
        command += ['--state-dir', args.state_dir]
    if args.test_confirm is not None:
        command += ['--test-confirm', args.test_confirm]
    if args.send:
        command.append('--send')
    elif args.status:
        command.append('--status')
    common.emit('Monad deployment mode: ' + ('interactive send (typed DEPLOY 143 required)' if args.send
                else 'read-only status' if args.status else 'preview only; no credential, no signing'))
    return subprocess.run(command, cwd=common.ROOT, env=env, check=False).returncode


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, common.OwnerRefusal) as exc:
        common.fail(exc)
