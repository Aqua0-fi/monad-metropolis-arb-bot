import copy
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('owner_refresh_remote', Path(__file__).with_name('owner-refresh-remote.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
REAL_PROBE = m.probe


class OwnerRefreshTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.paths = {name: self.root / name for name in ['CONFIG', 'DATA', 'BACKUPS', 'BUILD']}
        self.paths['RUNNER'] = self.root / 'run-worker.sh'
        for key, path in self.paths.items():
            if key == 'RUNNER':
                path.write_text('unchanged runner\n')
            else:
                path.mkdir()
        cfg = self.paths['CONFIG']
        (cfg / 'settings.json').write_text(json.dumps({'mode': 'execute', 'networkMode': 'mainnet', 'execution': {'42161': {'maxInput': '5000000'}}}))
        (cfg / 'observer.json').write_text(json.dumps({'REBALANCER_REPORT_TOKEN': 'synthetic-test-only'}))
        (cfg / 'image.env').write_text('IMAGE_ID=' + m.OLD + '\n')
        (self.paths['DATA'] / 'journal.json').write_text('{}')
        (self.paths['DATA'] / 'history.sqlite').write_bytes(b'preserve this history')
        (self.paths['BUILD'] / 'build-complete.json').write_text(json.dumps({'sourceCommit': m.SOURCE, 'image': m.NEW}))
        self.image = m.OLD
        self.active = True
        self.calls = []
        self.fail_new_start = False
        self.pending_after_stop = False
        self.calls_after_start = 0
        self.status = {'mode': 'execute', 'network': 'mainnet', 'chains': [{'chainId': 42161}], 'operatingControl': {'paused': False, 'pausedChains': []}, 'economics': {'pending': 0, 'blocked': False}}
        self.validation = {'finalProofFresh': True, 'withinCurrentTaskBudget': True, 'signatures': 0, 'transactions': 0}
        self.patches = [patch.object(m, k, v) for k, v in self.paths.items()]
        self.patches += [patch.object(m, 'run', self.fake_run), patch.object(m, 'get', self.get), patch.object(m, 'probe', lambda h: copy.deepcopy(self.validation))]
        for item in self.patches:
            item.start()
        self.request = {'action': 'apply', 'confirmed': True, 'probeHash': 'a' * 64}

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def fake_run(self, args, timeout=30):
        self.calls.append(args)
        if args[:2] == ['systemctl', 'is-active']:
            return 'active' if self.active else 'inactive'
        if args[:2] == ['systemctl', 'stop']:
            self.active = False
            if self.pending_after_stop:
                (m.DATA / 'journal.json').write_text(json.dumps({'account': {'pending': {'hash': 'test-pending'}}}))
            return ''
        if args[:2] == ['systemctl', 'start']:
            image = (m.CONFIG / 'image.env').read_text().strip().split('=', 1)[1]
            if image == m.NEW and self.fail_new_start:
                (m.DATA / 'new-pending-proof.json').write_text('do not erase this')
                raise RuntimeError('Synthetic start failure')
            self.image = image
            self.active = True
            self.calls_after_start += 1
            return ''
        if args[:3] == ['docker', 'image', 'inspect']:
            return m.NEW
        if args[:2] == ['docker', 'inspect']:
            return self.image
        raise AssertionError(args)

    def get(self, path):
        if path == '/v1/status':
            return copy.deepcopy(self.status)
        if path in ['/v1/markets', '/v1/aqua-markets']:
            return {'markets': [{'market': {'stableStrategyId': 'unchanged-strategy'}, 'policy': {'approved': True, 'version': 1}}]}
        if path.startswith('/v1/executions'):
            return {'matchedCount': 0}
        raise AssertionError(path)

    def test_status_and_missing_confirmation_never_restart_or_write(self):
        before = (m.CONFIG / 'image.env').read_bytes()
        result = m.main({**self.request, 'action': 'status', 'confirmed': False})
        self.assertFalse(result['changed'])
        with self.assertRaisesRegex(RuntimeError, 'confirmation'):
            m.main({**self.request, 'confirmed': False})
        self.assertEqual((m.CONFIG / 'image.env').read_bytes(), before)
        self.assertFalse(any(a[:2] == ['systemctl', 'stop'] for a in self.calls))

    def test_failed_actual_timing_check_leaves_original_running(self):
        self.validation['withinCurrentTaskBudget'] = False
        result = m.main(self.request)
        self.assertEqual(result['state'], 'validation-blocked')
        self.assertFalse(result['changed'])
        self.assertEqual(self.image, m.OLD)
        self.assertTrue(self.active)
        self.assertFalse(any(a[:2] == ['systemctl', 'stop'] for a in self.calls))

    def test_image_only_upgrade_preserves_existing_controls_credentials_and_history(self):
        original = {str(p): p.read_bytes() for p in [m.CONFIG / 'settings.json', m.CONFIG / 'observer.json', m.DATA / 'journal.json', m.DATA / 'history.sqlite', m.RUNNER]}
        result = m.main(self.request)
        self.assertEqual(result['state'], 'updated')
        self.assertEqual(self.image, m.NEW)
        self.assertFalse(result['historyRestored'])
        for p, value in original.items():
            self.assertEqual(Path(p).read_bytes(), value)
        self.status['economics']['pending'] = 1
        self.assertEqual(m.main(self.request)['state'], 'already-updated')
        self.assertEqual(self.calls_after_start, 1)

    def test_pending_before_or_during_stop_is_not_discarded(self):
        self.status['economics']['pending'] = 1
        with self.assertRaisesRegex(RuntimeError, 'Pending'):
            m.main(self.request)
        self.status['economics']['pending'] = 0
        self.pending_after_stop = True
        with self.assertRaisesRegex(RuntimeError, 'pending'):
            m.main(self.request)
        self.assertEqual(self.image, m.OLD)
        self.assertTrue(self.active)
        self.assertIn('test-pending', (m.DATA / 'journal.json').read_text())

    def test_failed_new_start_rolls_back_only_image_not_runtime(self):
        self.fail_new_start = True
        with self.assertRaisesRegex(RuntimeError, 'Synthetic'):
            m.main(self.request)
        self.assertEqual(self.image, m.OLD)
        self.assertTrue(self.active)
        self.assertEqual((m.DATA / 'new-pending-proof.json').read_text(), 'do not erase this')
        self.assertEqual((m.DATA / 'history.sqlite').read_bytes(), b'preserve this history')

    def test_probe_uses_live_settings_and_policy_without_mounting_signer_or_runtime(self):
        from types import SimpleNamespace
        source = m.BUILD / 'source/config'
        source.mkdir(parents=True)
        (source / 'arbitrum-pilot.json').write_text(json.dumps({'strategyId': 'unchanged-strategy'}))
        program = m.BUILD / 'host-readonly-probe.mjs'
        program.write_text('test-only program bytes')
        (m.CONFIG / 'observer.json').write_text(json.dumps({'AQUA0_READ_API_KEY': 'test-only-' * 3}))
        policy = {'approved': True, 'maxInput': '1000000', 'minNetProfit': '20000', 'version': 4}
        def fake_get(path):
            self.assertEqual(path, '/v1/aqua-markets')
            return {'markets': [{'market': {'stableStrategyId': 'unchanged-strategy'}, 'readyToQuote': True, 'policy': policy}]}
        def fake_process(args, **kwargs):
            payload = json.loads(kwargs['input'])
            self.assertEqual(set(payload), {'readKey', 'settings', 'policy'})
            self.assertEqual(payload['policy'], policy)
            self.assertEqual(payload['settings']['mode'], 'execute')
            self.assertNotIn(str(m.DATA), ' '.join(args))
            self.assertNotIn('signer/aws', ' '.join(args))
            self.assertNotIn('--env', args)
            return SimpleNamespace(returncode=0, stdout=json.dumps({'sourceCommit': m.SOURCE, 'signatures': 0, 'transactions': 0, 'liveSettingsChanged': False}))
        with patch.object(m, 'get', fake_get), patch.object(m.subprocess, 'run', fake_process):
            result = REAL_PROBE(m.digest(program))
        self.assertEqual(result['signatures'], 0)

    def test_noninteractive_owner_wrapper_refuses_before_reading_release_or_ssh(self):
        p = subprocess.run(['python3', str(Path(__file__).with_name('owner-refresh-arbitrum.py')), '--apply'], input='', text=True, capture_output=True)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('interactive terminal', p.stdout)


if __name__ == '__main__':
    unittest.main()
