"""Offline host tests. Every path and host/API command is replaced with local fixtures."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name('owner-pilot-remote.py')


class OwnerRemoteTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('pilot_remote_test', SOURCE)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        self.temp = tempfile.TemporaryDirectory(prefix='owner-pilot-offline-')
        base = Path(self.temp.name)
        self.m.ROOT = base / 'etc'
        self.m.DATA = base / 'data'
        self.m.BACKUPS = base / 'backups'
        self.m.RUNNER = base / 'runner.sh'
        for p in (self.m.ROOT, self.m.DATA, self.m.BACKUPS):
            p.mkdir()
        self.m.RUNNER.write_text('#!/bin/sh\ndocker run \\\n  --env AWS_EC2_METADATA_DISABLED=true \\\n  image node dist/src/cli.js run --config /etc/rebalancer/settings.json --chain 42161\n')
        self.p = json.loads((SOURCE.parent.parent / 'config/arbitrum-pilot.json').read_text())
        self.p['image'] = 'sha256:' + 'a' * 64
        self.settings = {'mode': 'observe', 'networkMode': 'mainnet', 'apiUrl': 'https://staging-api.aqua0.xyz',
                         'execution': {}, 'markets': [], 'slippageBps': 10}
        (self.m.ROOT / 'settings.json').write_text(json.dumps(self.settings))
        (self.m.ROOT / 'observer.json').write_text('{}')
        (self.m.DATA / 'journal.json').write_text('{"account": {"dailyGas": "123", "other": "preserve"}}')
        (self.m.DATA / 'history.sqlite').write_bytes(b'opaque preserved database bytes')
        self.journal = (self.m.DATA / 'journal.json').read_bytes()
        self.history = (self.m.DATA / 'history.sqlite').read_bytes()
        self.policy = None
        self.control = {'paused': False, 'pausedChains': []}
        self.economics = {'blocked': False, 'pending': 0}
        self.calls = []
        self.writes = []
        self.market = {'chainId': 42161, 'stableStrategyId': self.p['strategyId'], 'maker': self.p['maker'], 'classId': self.p['classId']}
        self.execution = {'executor': self.p['executor'], 'operator': self.p['owner'], 'allowBroadcast': False,
                          'externalPools': [self.p['externalPool']], 'maxDailyGasWei': self.p['maxDailyGasWei'], 'liveFeeBufferBps': 10500}
        self.request = {'policy': self.p, 'ownerConfirmation': 'START ARBITRUM 5 USDC', 'execution': self.execution,
                        'credentials': {'accessKeyId': 'A' * 20, 'secretAccessKey': 'x' * 40}}
        self.chown = patch.object(self.m.os, 'chown', lambda *args: None)
        self.chown.start()
        self.m.run = self.command
        self.m.report = self.report

    def tearDown(self):
        self.chown.stop()
        self.temp.cleanup()

    def command(self, args, timeout=40):
        self.calls.append(args)
        if args[:2] == ['docker', 'inspect']:
            return json.dumps(['node', 'dist/src/cli.js', 'run', '--config', '/etc/rebalancer/settings.json', '--chain', '42161']) if 'Cmd' in args[3] else self.p['image']
        if args[:2] == ['docker', 'exec']:
            return json.dumps({'address': self.p['owner'], 'signatures': 0})
        if args[0] != 'systemctl':
            raise AssertionError('Unexpected host command')
        return ''

    def report(self, path, body=None):
        settings = json.loads((self.m.ROOT / 'settings.json').read_text())
        if body is not None:
            self.writes.append((path, body))
            self.assertEqual(body['network'], 'mainnet')
            self.assertEqual(body['actor'], 'owner:' + self.p['owner'])
            expected = 0 if self.policy is None else self.policy['version']
            self.assertEqual(body['policy']['expectedVersion'], expected)
            self.policy = {**body['policy'], 'version': expected + 1}
            self.policy.pop('expectedVersion')
            return {'policy': self.policy}
        if path == '/v1/status':
            return {'mode': settings['mode'], 'network': 'mainnet', 'operatingControl': self.control,
                    'economics': self.economics, 'chains': [{'chainId': 42161, 'executionEnabled': settings['mode'] == 'execute'}]}
        if path == '/v1/markets':
            return {'markets': []}
        if path == '/v1/aqua-markets':
            return {'markets': [{'market': self.market, 'present': True, 'blockers': [], 'policy': self.policy}]}
        if path.startswith('/v1/executions'):
            return {'matchedCount': 0}
        raise AssertionError('Unexpected local API route')

    def test_preflight_has_no_mutations_and_unconfirmed_actions_are_refused(self):
        r = self.m.main({'action': 'preflight', 'policy': self.p})
        self.assertEqual(r['mode'], 'observe')
        self.assertTrue(all(c[:2] == ['docker', 'inspect'] for c in self.calls))
        self.assertEqual(self.writes, [])
        self.assertEqual(json.loads((self.m.ROOT / 'settings.json').read_text()), self.settings)
        with self.assertRaisesRegex(RuntimeError, 'owner'):
            self.m.main({'action': 'stage', 'policy': self.p})
        with self.assertRaisesRegex(RuntimeError, 'onchain'):
            self.m.main({**self.request, 'action': 'activate'})

    def test_staging_is_observe_only_preserves_data_and_mounts_rotatable_directory(self):
        r = self.m.main({**self.request, 'action': 'stage'})
        self.assertEqual(r['mode'], 'observe')
        self.assertFalse(r['tradingEnabled'])
        self.assertEqual((self.m.DATA / 'journal.json').read_bytes(), self.journal)
        self.assertEqual((self.m.DATA / 'history.sqlite').read_bytes(), self.history)
        settings = json.loads((self.m.ROOT / 'settings.json').read_text())
        self.assertEqual(settings['execution'], {'42161': self.execution})
        self.assertEqual(settings['slippageBps'], 10)
        self.assertEqual((self.m.ROOT / 'settings.json').stat().st_mode & 0o777, 0o644)
        credentials = self.m.ROOT / 'signer' / 'aws.json'
        self.assertEqual(credentials.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(credentials.read_text()), self.request['credentials'])
        self.assertIn('src=/etc/aqua0-market-rebalancer/signer,dst=/run/secrets/signer,readonly', self.m.RUNNER.read_text())
        self.assertIn('REBALANCER_AWS_CREDENTIALS_FILE=/run/secrets/signer/aws.json', self.m.RUNNER.read_text())
        self.assertEqual(len(self.writes), 1)
        self.m.main({**self.request, 'action': 'stage'})
        self.assertEqual(len(self.writes), 1, 'The exact existing approval must not be rewritten')
        self.assertEqual(self.m.RUNNER.read_text().count('REBALANCER_AWS_CREDENTIALS_FILE='), 1)

    def test_only_verified_owner_activation_enables_exactly_arbitrum_and_is_idempotent(self):
        self.m.main({**self.request, 'action': 'stage'})
        result = self.m.main({**self.request, 'action': 'activate', 'onchainVerified': True})
        self.assertEqual(result['executionEnabledChains'], [42161])
        self.assertEqual(result['profitRecipient'], self.p['executor'])
        self.assertFalse(result['automaticLpReturns'])
        self.assertEqual((self.m.DATA / 'journal.json').read_bytes(), self.journal)
        before = len(self.calls)
        again = self.m.main({**self.request, 'action': 'activate', 'onchainVerified': True})
        self.assertTrue(again['alreadyActive'])
        self.assertTrue(all(call[:2] == ['docker', 'inspect'] for call in self.calls[before:]))

    def test_pauses_unknown_economics_pending_or_other_scopes_are_never_cleared(self):
        for update in ({'paused': True}, {'pausedChains': [42161]}):
            original = copy.deepcopy(self.control)
            self.control.update(update)
            with self.assertRaisesRegex(RuntimeError, 'pause'):
                self.m.main({**self.request, 'action': 'stage'})
            self.control = original
        self.economics['blocked'] = True
        with self.assertRaisesRegex(RuntimeError, 'economic'):
            self.m.main({**self.request, 'action': 'stage'})
        self.economics['blocked'] = False
        settings = {**self.settings, 'execution': {'8453': {'allowBroadcast': False}}}
        (self.m.ROOT / 'settings.json').write_text(json.dumps(settings))
        with self.assertRaisesRegex(RuntimeError, 'Other chain'):
            self.m.main({**self.request, 'action': 'stage'})
        self.assertEqual(self.writes, [])

    def test_activation_failure_returns_to_observe_without_discarding_account_or_history(self):
        self.m.main({**self.request, 'action': 'stage'})
        def fail(mode):
            if mode == 'execute':
                raise RuntimeError('simulated host check failure')
            return self.report('/v1/status')
        self.m.await_status = fail
        with self.assertRaisesRegex(RuntimeError, 'simulated'):
            self.m.main({**self.request, 'action': 'activate', 'onchainVerified': True})
        settings = json.loads((self.m.ROOT / 'settings.json').read_text())
        self.assertEqual(settings['mode'], 'observe')
        self.assertEqual(settings['execution'], {'42161': self.execution})
        self.assertEqual((self.m.DATA / 'journal.json').read_bytes(), self.journal)
        self.assertEqual((self.m.DATA / 'history.sqlite').read_bytes(), self.history)


if __name__ == '__main__':
    unittest.main()
