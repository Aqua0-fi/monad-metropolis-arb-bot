import copy
import importlib.util
import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('owner_reconcile_remote', Path(__file__).with_name('owner-reconcile-remote.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
REAL_CONTAINER = m.recovery_container
TX = '0x' + '33' * 32
SOURCE = 'a' * 40
IMAGE = 'sha256:' + 'b' * 64
OWNER = '0x' + '11' * 20
EXECUTOR = '0x' + '22' * 20


class OwnerReconcileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.paths = {name: root / name for name in ['CONFIG', 'DATA', 'BACKUPS', 'BUILD_ROOT']}
        self.paths['RUNNER'] = root / 'run-worker.sh'
        for name, path in self.paths.items():
            if name == 'RUNNER':
                path.write_text('preserved startup')
            else:
                path.mkdir()
        self.old = sorted(m.OLD_IMAGES)[0]
        cfg, data = self.paths['CONFIG'], self.paths['DATA']
        (cfg / 'image.env').write_text('IMAGE_ID=' + self.old + '\n')
        (cfg / 'settings.json').write_text(json.dumps({'mode': 'execute', 'networkMode': 'mainnet', 'execution': {'42161': {'operator': OWNER, 'executor': EXECUTOR}}}))
        (cfg / 'observer.json').write_text('private-but-synthetic-test-value')
        (data / 'controls.sqlite').write_text('preserve existing operator pauses')
        (data / 'journal.json').write_text(json.dumps({'42161:' + OWNER: {'day': '2026-09-29', 'reservedWei': '123', 'errors': 0, 'pending': {'hash': TX, 'nonce': 9, 'id': 'test-trade', 'historyRequired': True}}}))
        self.record = {'network': 'mainnet', 'chainId': 42161, 'transactionHash': TX, 'operator': OWNER, 'executor': EXECUTOR, 'tradeId': 'test-trade', 'status': 'pending', 'receipt': None}
        conn = sqlite3.connect(data / 'history.sqlite')
        conn.execute('CREATE TABLE executions(network TEXT,chain_id INTEGER,transaction_hash TEXT,payload TEXT)')
        conn.execute('INSERT INTO executions VALUES(?,?,?,?)', ('mainnet', 42161, TX, json.dumps(self.record)))
        conn.commit()
        conn.close()
        build = self.paths['BUILD_ROOT'] / ('20260929-receipt-' + SOURCE[:7])
        build.mkdir()
        (build / 'build-complete.json').write_text(json.dumps({'sourceCommit': SOURCE, 'image': IMAGE}))
        self.active = True
        self.image = self.old
        self.calls = []
        self.recovery_failure = False
        self.fail_start = False
        self.patches = [patch.object(m, name, value) for name, value in self.paths.items()]
        self.patches += [patch.object(m, 'run', self.fake_run), patch.object(m, 'recovery_container', self.fake_recovery)]
        for item in self.patches:
            item.start()
        self.request = {'confirmed': True, 'image': IMAGE, 'source': SOURCE, 'transaction': TX, 'rpcUrl': 'https://existing.example/test-only'}

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def fake_run(self, args, timeout=30):
        self.calls.append(args)
        if args[:3] == ['docker', 'image', 'inspect']:
            return IMAGE
        if args[:2] == ['docker', 'inspect']:
            return self.image + ' true' if '{{.State.Running}}' in args[3] else self.image
        if args[:2] == ['systemctl', 'show']:
            return 'active' if self.active else 'inactive'
        if args[:2] == ['systemctl', 'stop']:
            self.active = False
            return ''
        if args[:2] == ['systemctl', 'start']:
            if self.fail_start:
                raise RuntimeError('synthetic start failure')
            self.active = True
            self.image = (m.CONFIG / 'image.env').read_text().strip().split('=', 1)[1]
            return ''
        raise AssertionError(args)

    def fake_recovery(self, image, tx, rpc):
        self.assertFalse(self.active)
        self.assertEqual((image, tx), (IMAGE, TX))
        if self.recovery_failure:
            raise RuntimeError('complete historical evidence unavailable')
        record = m.read_record(TX)
        record.update(status='confirmed', receipt={'feeValuation': {'tokenCost': '46'}, 'grossProfit': '704'})
        conn = sqlite3.connect(m.DATA / 'history.sqlite')
        conn.execute('UPDATE executions SET payload=? WHERE transaction_hash=?', (json.dumps(record), TX))
        conn.commit()
        conn.close()
        path = m.DATA / 'journal.json'
        data = json.loads(path.read_text())
        data['42161:' + OWNER].pop('pending', None)
        path.write_text(json.dumps(data))
        return {'state': 'reconciled', 'transactionHash': TX, 'status': 'confirmed', 'receipt': record['receipt'], 'economics': {'blocked': False}, 'journalReleased': True, 'signatures': 0, 'transactions': 0}

    def test_confirmation_mismatch_and_other_hash_never_stop_service(self):
        with self.assertRaisesRegex(RuntimeError, 'confirmation'):
            m.main({**self.request, 'confirmed': False})
        with self.assertRaisesRegex(RuntimeError, 'transaction'):
            m.main({**self.request, 'transaction': '0x' + '44' * 32})
        self.assertTrue(self.active)
        self.assertFalse(any(a[:2] == ['systemctl', 'stop'] for a in self.calls))

    def test_success_settles_existing_record_and_replaces_only_code(self):
        protected = {str(p): p.read_bytes() for p in [m.CONFIG / 'settings.json', m.CONFIG / 'observer.json', m.RUNNER, m.DATA / 'controls.sqlite']}
        answer = m.main(self.request)
        self.assertEqual(answer['state'], 'reconciled-and-updated')
        self.assertEqual(self.image, IMAGE)
        self.assertTrue(self.active)
        self.assertEqual(m.read_record(TX)['status'], 'confirmed')
        self.assertNotIn('pending', json.loads((m.DATA / 'journal.json').read_text())['42161:' + OWNER])
        for path, original in protected.items():
            self.assertEqual(Path(path).read_bytes(), original)
        m.main(self.request)
        self.assertEqual(m.read_record(TX)['status'], 'confirmed')

    def test_unverifiable_receipt_leaves_worker_stopped_and_original_pending_evidence(self):
        self.recovery_failure = True
        with self.assertRaisesRegex(RuntimeError, 'historical'):
            m.main(self.request)
        self.assertFalse(self.active)
        self.assertEqual(m.read_record(TX)['status'], 'pending')
        self.assertIn('pending', json.loads((m.DATA / 'journal.json').read_text())['42161:' + OWNER])
        self.assertEqual((m.CONFIG / 'image.env').read_text().strip(), 'IMAGE_ID=' + self.old)

    def test_start_failure_never_restores_stale_history_or_pending_state(self):
        self.fail_start = True
        with self.assertRaisesRegex(RuntimeError, 'start'):
            m.main(self.request)
        self.assertFalse(self.active)
        self.assertEqual(m.read_record(TX)['status'], 'confirmed')
        self.assertNotIn('pending', json.loads((m.DATA / 'journal.json').read_text())['42161:' + OWNER])
        self.fail_start = False
        self.assertEqual(m.main(self.request)['state'], 'reconciled-and-updated')
        self.assertTrue(self.active)

    def test_recovery_container_has_no_signer_mount_or_environment_and_keeps_flock(self):
        def fake_process(args, **kwargs):
            text = ' '.join(args)
            self.assertNotIn('--entrypoint', args)
            self.assertNotIn('signer/', text)
            self.assertNotIn('AWS_ACCESS_KEY', text)
            self.assertNotIn(self.request['rpcUrl'], text)
            self.assertIn('dist/src/receipt-recovery.js', args)
            self.assertEqual(json.loads(kwargs['input']), {'rpcUrl': self.request['rpcUrl']})
            return SimpleNamespace(returncode=0, stdout=json.dumps({'state': 'reconciled', 'network': 'mainnet', 'chainId': 42161, 'transactionHash': TX, 'signatures': 0, 'transactions': 0, 'journalReleased': True, 'receipt': {'feeValuation': {'tokenCost': '46'}}}))
        with patch.object(m.subprocess, 'run', fake_process):
            self.assertEqual(REAL_CONTAINER(IMAGE, TX, self.request['rpcUrl'])['state'], 'reconciled')

    def test_owner_wrapper_refuses_noninteractive_application_before_config_or_ssh(self):
        p = subprocess.run(['python3', str(Path(__file__).with_name('owner-reconcile-arbitrum.py')), '--image', IMAGE, '--source', SOURCE, '--transaction', TX, '--apply'], input='', text=True, capture_output=True)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('stopped', p.stdout)


if __name__ == '__main__':
    unittest.main()
