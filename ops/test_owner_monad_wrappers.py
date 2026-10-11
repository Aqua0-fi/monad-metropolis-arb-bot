"""Refusal tests for the owner-run Monad wrappers. Every case must stop before credentials, RPC or signing."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

OPS = Path(__file__).resolve().parent
ROOT = OPS.parent
sys.path.insert(0, str(OPS))
import owner_monad_common as common  # noqa: E402

spec = importlib.util.spec_from_file_location('owner_bridge', OPS / 'owner-bridge-arbitrum-to-monad.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def run(script, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith(('AWS_', 'MARKET_REBALANCER_'))}
    return subprocess.run([sys.executable, str(OPS / script), *args], cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=20)


class WrapperRefusals(unittest.TestCase):
    def assertRefused(self, result, pattern):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertRegex(result.stdout, pattern)
        self.assertNotRegex(result.stdout, 'transactionHash|signed ')

    def test_signing_modes_refuse_a_non_interactive_terminal(self):
        self.assertRefused(run('owner-deploy-monad.py', '--send'), 'interactive terminal')
        self.assertRefused(run('owner-setup-monad.py', '--enable'), 'interactive terminal')
        self.assertRefused(run('owner-bridge-arbitrum-to-monad.py', '--send'), 'interactive terminal')
        self.assertRefused(run('owner-timed-run-monad.py', '--minutes', '5'), 'interactive terminal')
        self.assertRefused(run('owner-timed-run-monad.py', '--close-only'), 'interactive terminal')

    def test_minute_cap_and_bridge_cap(self):
        self.assertRefused(run('owner-timed-run-monad.py', '--minutes', '61', '--observe'), 'from 1 to 60')
        self.assertRefused(run('owner-bridge-arbitrum-to-monad.py', '--amount-eth', '0.0016'), 'at most 0.0015')
        for bad in ('0.0016', '1', '0', '1e-3', '', '0.0015000000000000001'):
            with self.assertRaises(common.OwnerRefusal, msg=bad):
                bridge.validate_amount(bad)
        self.assertEqual(bridge.validate_amount('0.0015'), '0.0015')

    def test_test_signer_and_paid_rpc_are_refused_on_real_networks(self):
        self.assertRefused(run('owner-deploy-monad.py', '--signer', 'anvil-test', '--send'), '127.0.0.1')
        self.assertRefused(run('owner-setup-monad.py', '--signer', 'anvil-test', '--rpc', 'https://rpc2.monad.xyz'),
                           '127.0.0.1')
        self.assertRefused(run('owner-deploy-monad.py', '--test-confirm', 'DEPLOY 143', '--rpc', 'http://127.0.0.1:1'),
                           'anvil-test')
        self.assertRefused(run('owner-deploy-monad.py', '--rpc', 'https://monad-mainnet.core.chainstack.com/x'),
                           'allowlist')

    def test_rpc_guard_and_environment_scrub(self):
        common.validate_rpc('https://rpc2.monad.xyz', {})
        common.validate_rpc('http://127.0.0.1:8545', {})
        for bad in ('https://rpc2.monad.xyz/token', 'http://rpc2.monad.xyz', 'https://evil.example', 'http://localhost:1'):
            with self.assertRaises(common.OwnerRefusal, msg=bad):
                common.validate_rpc(bad, {})
        with self.assertRaisesRegex(common.OwnerRefusal, 'paid'):
            common.validate_rpc('https://rpc-mainnet.monadinfra.com', {'RPC_URL_MAINNET_MONAD': 'https://rpc-mainnet.monadinfra.com/'})
        env = common.scrubbed_env({'RPC_URL_MAINNET_MONAD': 'x', 'AWS_SECRET_ACCESS_KEY': 'x', 'AQUA0_READ_API_KEY': 'x',
                                   'MARKET_REBALANCER_KMS_KEY_ID': 'x', 'PATH': '/bin'})
        self.assertEqual(sorted(k for k in env if not k.startswith('AWS_') or k in ('AWS_SECRET_ACCESS_KEY',)), ['PATH'])
        self.assertEqual(env['AWS_CONFIG_FILE'], '/dev/null')

    def test_secret_files_must_be_private_and_only_named_keys_are_read(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'k.json'
            path.write_text(json.dumps({'AQUA0_READ_API_KEY': 'v', 'OTHER': 'w'}))
            os.chmod(path, 0o644)
            with self.assertRaisesRegex(common.OwnerRefusal, '600'):
                common.load_json_key(path, 'AQUA0_READ_API_KEY')
            os.chmod(path, 0o600)
            self.assertEqual(common.load_json_key(path, 'AQUA0_READ_API_KEY'), 'v')
            self.assertIsNone(common.load_json_key(Path(folder) / 'missing.json', 'AQUA0_READ_API_KEY'))
            link = Path(folder) / 'link.json'
            link.symlink_to(path)
            with self.assertRaises(common.OwnerRefusal):
                common.load_json_key(link, 'AQUA0_READ_API_KEY')


if __name__ == '__main__':
    unittest.main()
