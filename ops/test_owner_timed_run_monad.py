"""Unit tests for ops/owner-timed-run-monad.py. No network, KMS, RPC or node process is used:
owner-window calls are faked and the worker is test/fixtures/fake-monad-worker.py."""
import atexit
import importlib.util
import json
import os
import signal
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

OPS = Path(__file__).resolve().parent
sys.path.insert(0, str(OPS))
import owner_monad_common as common  # noqa: E402

spec = importlib.util.spec_from_file_location('owner_timed_run_monad', OPS / 'owner-timed-run-monad.py')
tr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tr)
FAKE_WORKER = str(OPS.parent / 'test' / 'fixtures' / 'fake-monad-worker.py')
LOOP = 'http://127.0.0.1:18999'


class FakeNode:
    def __init__(self, codes=None):
        self.calls = []
        self.codes = codes or {}

    def __call__(self, args, env, interactive=False, timeout=600):
        self.calls.append((args[0], dict(env)))
        return self.codes.get(args[0], 0)

    def names(self):
        return [name for name, _ in self.calls]


def write_secret(folder, name, content):
    path = Path(folder) / name
    path.write_text(content)
    os.chmod(path, 0o600)


class TimedRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.secrets = self.dir / 'secrets'
        self.secrets.mkdir(mode=0o700)
        write_secret(self.secrets, 'market-rebalancer-observer.json', json.dumps({'AQUA0_READ_API_KEY': 'read-test'}))
        write_secret(self.secrets, 'market-rebalancer-operator.json', json.dumps({'AQUA0_OPERATOR_API_KEY': 'op-test'}))
        write_secret(self.secrets, 'market-rebalancer.aws.env', '\n'.join([
            'AWS_REGION=us-east-1', 'AWS_ACCESS_KEY_ID=AKIATESTTESTTESTTEST', 'AWS_SECRET_ACCESS_KEY=' + 'x' * 40,
            'MARKET_REBALANCER_KMS_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012',
            'MARKET_REBALANCER_OPERATOR_ADDRESS=0xd1fC4c8631E8C5d23a0C86D5890802DD70Cb4cf5']))
        self.handlers = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
        self.runs = []
        self.lines = []

    def tearDown(self):
        for sig, handler in self.handlers.items():
            signal.signal(sig, handler)
        for run in self.runs:
            atexit.unregister(run.ensure_closed)
            if run.worker is not None and run.worker.poll() is None:
                run.signal_worker_group(signal.SIGKILL)
        self.tmp.cleanup()

    def make(self, argv, node=None, worker_mode='crash', environ=None, reader=input):
        args = tr.parse(argv + ['--state-dir', str(self.dir / 'state')])
        env = dict(os.environ if environ is None else environ, FAKE_WORKER_MODE=worker_mode)
        run = tr.TimedRun(args, run_node=node or FakeNode(), environ=env, reader=reader, out=self.lines.append)
        self.runs.append(run)
        return run

    def loop_args(self, *extra):
        return ['--rpc', LOOP, '--signer', 'anvil-test', '--secrets-dir', str(self.secrets),
                '--test-worker', FAKE_WORKER, *extra]

    # -- argument guards --------------------------------------------------------------------------
    def test_minutes_are_capped_at_sixty(self):
        for argv in (['--minutes', '61'], ['--minutes', '0'], [], ['--close-only', '--minutes', '5'],
                     ['--minutes', '5', '--observe', '--close-only']):
            with self.assertRaises(common.OwnerRefusal, msg=argv):
                tr.parse(argv)
        self.assertEqual(tr.parse(['--minutes', '60']).minutes, 60)

    def test_test_only_switches_require_a_loopback_fork(self):
        for argv in (['--minutes', '1', '--signer', 'anvil-test'],
                     ['--minutes', '1', '--rpc', 'https://rpc2.monad.xyz', '--test-worker', FAKE_WORKER],
                     ['--minutes', '1', '--test-confirm', 'RUN MONAD 1 MIN'],
                     ['--minutes', '1', '--secrets-dir', '/tmp'],
                     ['--minutes', '1', '--rpc', 'http://localhost:8545', '--test-worker-home', '/tmp']):
            with self.assertRaisesRegex(common.OwnerRefusal, 'test-only', msg=argv):
                tr.parse(argv)

    def test_wrong_or_paid_rpc_is_refused(self):
        with self.assertRaisesRegex(common.OwnerRefusal, 'paid'):
            self.make(['--minutes', '1', '--rpc', 'https://rpc2.monad.xyz'],
                      environ={'RPC_URL_MAINNET_MONAD': 'https://rpc2.monad.xyz/'})
        with self.assertRaisesRegex(common.OwnerRefusal, 'allowlist'):
            self.make(['--minutes', '1', '--rpc', 'https://monad-mainnet.core.chainstack.com/abc'], environ={})

    # -- credentials ------------------------------------------------------------------------------
    def test_non_interactive_execute_refuses_before_any_credential_or_rpc(self):
        node = FakeNode()
        run = self.make(['--minutes', '5'], node=node, environ={})
        with mock.patch.object(common, 'interactive', return_value=False), \
                mock.patch.object(common, 'load_aws_env', side_effect=AssertionError('credential read')), \
                mock.patch.object(common, 'load_json_key', side_effect=AssertionError('credential read')):
            with self.assertRaisesRegex(common.OwnerRefusal, 'interactive terminal'):
                run.run()
        self.assertEqual(node.calls, [])
        self.assertFalse((self.dir / 'state').exists())

    def test_missing_operator_key_refuses_execute_but_observe_still_works(self):
        (self.secrets / 'market-rebalancer-operator.json').unlink()
        execute = self.make(['--minutes', '5', '--rpc', LOOP, '--secrets-dir', str(self.secrets)], environ={})
        with mock.patch.object(common, 'interactive', return_value=True):
            with self.assertRaisesRegex(common.OwnerRefusal, 'AQUA0_OPERATOR_API_KEY.*--observe'):
                execute.load_credentials()
        observe = self.make(['--minutes', '5', '--observe', '--rpc', LOOP, '--secrets-dir', str(self.secrets)],
                            environ={'AWS_ACCESS_KEY_ID': 'ambient', 'AQUA0_OPERATOR_API_KEY': 'ambient'})
        observe.load_credentials()
        self.assertEqual(observe.worker_env['AQUA0_READ_API_KEY'], 'read-test')
        self.assertNotIn('AQUA0_OPERATOR_API_KEY', observe.worker_env)
        self.assertNotIn('AWS_ACCESS_KEY_ID', observe.worker_env)
        self.assertNotIn('AWS_ACCESS_KEY_ID', observe.owner_env)

    def test_worker_never_inherits_the_paid_rpc_variable_unless_rpc_is_explicit(self):
        ambient = {'RPC_URL_MAINNET_MONAD': 'https://paid.example/key', 'AWS_SECRET_ACCESS_KEY': 'ambient',
                   'AQUA0_READ_API_KEY': 'ambient', 'PATH': os.environ.get('PATH', '')}
        with mock.patch.object(common, 'SECRETS', self.secrets):
            run = self.make(['--minutes', '5', '--observe'], environ=ambient)
            run.load_credentials()
        self.assertNotIn('RPC_URL_MAINNET_MONAD', run.worker_env)
        self.assertNotIn('AWS_SECRET_ACCESS_KEY', run.worker_env)
        self.assertEqual(run.worker_env['AQUA0_READ_API_KEY'], 'read-test')
        explicit = self.make(['--minutes', '5', '--observe', '--rpc', LOOP, '--secrets-dir', str(self.secrets)],
                             environ=ambient)
        explicit.load_credentials()
        self.assertEqual(explicit.worker_env['RPC_URL_MAINNET_MONAD'], LOOP)

    # -- confirmation and preflight ---------------------------------------------------------------
    def test_typed_phrase_mismatch_signs_nothing(self):
        node = FakeNode()
        run = self.make(['--minutes', '2'] + self.loop_args(), node=node, reader=lambda _p: 'RUN MONAD 3 MIN')
        self.assertEqual(run.run(), tr.EXIT_FAIL)
        self.assertEqual(node.names(), ['preflight'])
        node = FakeNode()
        run = self.make(['--minutes', '2'] + self.loop_args('--test-confirm', 'run monad 2 min'), node=node)
        self.assertEqual(run.run(), tr.EXIT_FAIL)
        self.assertEqual(node.names(), ['preflight'])

    def test_preflight_refusal_stops_before_any_onchain_action(self):
        node = FakeNode({'preflight': 2})
        run = self.make(['--minutes', '1'] + self.loop_args('--test-confirm', 'RUN MONAD 1 MIN'), node=node)
        self.assertEqual(run.run(), tr.EXIT_PREFLIGHT)
        self.assertEqual(node.names(), ['preflight'])
        self.assertNotIn('RPC_URL_MAINNET_MONAD', node.calls[0][1])

    # -- the finally path -------------------------------------------------------------------------
    def test_finally_path_disables_even_when_the_worker_crashes(self):
        node = FakeNode()
        run = self.make(['--minutes', '1'] + self.loop_args('--test-confirm', 'RUN MONAD 1 MIN'), node=node)
        self.assertEqual(run.run(), tr.EXIT_FAIL)
        self.assertEqual(run.worker.returncode, 7)
        self.assertEqual(node.names(), ['preflight', 'open', 'close', 'status', 'summary'])
        self.assertTrue(run.closed_verified)

    def test_open_failure_still_closes_and_never_launches_the_worker(self):
        node = FakeNode({'open': 1})
        run = self.make(['--minutes', '1'] + self.loop_args('--test-confirm', 'RUN MONAD 1 MIN'), node=node)
        self.assertEqual(run.run(), tr.EXIT_FAIL)
        self.assertIsNone(run.worker)
        self.assertEqual(node.names(), ['preflight', 'open', 'close', 'status', 'summary'])

    def test_sigterm_during_the_run_stops_the_worker_and_closes(self):
        node = FakeNode()
        run = self.make(['--minutes', '1'] + self.loop_args('--test-confirm', 'RUN MONAD 1 MIN'), node=node,
                        worker_mode='sleep')
        timer = threading.Timer(1.5, os.kill, (os.getpid(), signal.SIGTERM))
        timer.start()
        started = time.monotonic()
        try:
            self.assertEqual(run.run(), tr.EXIT_FAIL)
        finally:
            timer.cancel()
        self.assertLess(time.monotonic() - started, 30)
        self.assertIsNotNone(run.worker.poll())
        self.assertEqual(node.names(), ['preflight', 'open', 'close', 'status', 'summary'])
        self.assertTrue(any('Interrupted by signal' in line for line in self.lines))

    def test_signal_during_open_is_deferred_until_the_owner_transaction_settles(self):
        def slow_open(args, env, interactive=False, timeout=600):
            node.calls.append((args[0], env))
            if args[0] == 'open':
                os.kill(os.getpid(), signal.SIGINT)
                time.sleep(0.2)
            return 0
        node = FakeNode()
        run = self.make(['--minutes', '1'] + self.loop_args('--test-confirm', 'RUN MONAD 1 MIN'), node=slow_open,
                        worker_mode='sleep')
        self.assertEqual(run.run(), tr.EXIT_FAIL)
        self.assertIsNone(run.worker)
        self.assertEqual(node.names(), ['preflight', 'open', 'close', 'status', 'summary'])

    def test_wall_clock_limit_kills_a_hanging_worker_process_group(self):
        node = FakeNode()
        run = self.make(['--minutes', '1', '--observe'] + self.loop_args(), node=node, worker_mode='hang')
        with mock.patch.object(tr, 'KILL_SLACK_SECONDS', -58), mock.patch.object(tr, 'TERM_GRACE_SECONDS', 1):
            self.assertEqual(run.run(), tr.EXIT_FAIL)
        self.assertEqual(run.worker.returncode, -signal.SIGKILL)
        grandchild = None
        for line in (run.run_dir / 'worker.log').read_text().splitlines():
            if '"grandchild"' in line:
                grandchild = json.loads(line)['pid']
        self.assertIsNotNone(grandchild)
        for _ in range(40):
            try:
                os.kill(grandchild, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            self.fail('grandchild survived the process-group kill')
        self.assertEqual(node.names(), ['preflight', 'summary'])  # observe: no onchain calls

    def test_observe_mode_never_opens_or_closes(self):
        node = FakeNode()
        run = self.make(['--minutes', '1', '--observe'] + self.loop_args(), node=node, worker_mode='crash')
        run.run()
        self.assertEqual(node.names(), ['preflight', 'summary'])

    def test_unverified_close_is_reported_loudly(self):
        node = FakeNode({'close': 1})
        run = self.make(['--close-only', '--rpc', LOOP, '--signer', 'anvil-test'], node=node)
        with mock.patch.object(tr.time, 'sleep'):
            self.assertEqual(run.run(), tr.EXIT_NOT_CLOSED)
        self.assertEqual(node.names(), ['close', 'close', 'close'])
        self.assertTrue(any('NOT VERIFIED OFF' in line for line in self.lines))
        self.assertTrue(any('--close-only' in line for line in self.lines))


if __name__ == '__main__':
    unittest.main()
