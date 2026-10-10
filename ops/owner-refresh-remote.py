#!/usr/bin/env python3
"""Owner-invoked image-only repair. No signing, funding, permission edits or data rollback."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path

CONFIG = Path('/etc/aqua0-market-rebalancer')
DATA = Path('/var/lib/aqua0-market-rebalancer')
BACKUPS = Path('/var/lib/aqua0-market-rebalancer-backups')
BUILD = Path('/home/ubuntu/market-rebalancer-builds/20260929-head-align-eb79f02')
RUNNER = Path('/opt/aqua0-market-rebalancer/run-observer-container.sh')
UNIT = 'aqua0-market-rebalancer.service'
CONTAINER = 'aqua0-market-rebalancer'
SOURCE = 'eb79f029e83e52616e193dea4a886c58707acea6'
OLD = 'sha256:4ffa8e6394f59a80a1fd2caf84246878db89e974609ae4e6362cc547f3592312'
NEW = 'sha256:23d2b8bba286faad7066f60962c8b922b0cd187d8ba1ebdc45316f842eb0c421'


def run(args, timeout=30):
    p = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError('Required host command failed: ' + args[0])
    return p.stdout.strip()


def digest(path):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError('Unexpected file type during upgrade preflight')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def get(path):
    secret = json.loads((CONFIG / 'observer.json').read_text())
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))
    req = urllib.request.Request('http://127.0.0.1:9191' + path, headers={
        'Authorization': 'Bearer ' + secret['REBALANCER_REPORT_TOKEN'], 'Accept': 'application/json'})
    with opener.open(req, timeout=10) as response:
        data = response.read(4_000_001)
    if len(data) > 4_000_000:
        raise RuntimeError('Oversized worker status')
    return json.loads(data)


def pending(value):
    if isinstance(value, dict):
        return bool(value.get('pending')) or any(pending(x) for x in value.values())
    return isinstance(value, list) and any(pending(x) for x in value)


def check_journal():
    path = DATA / 'journal.json'
    if path.exists():
        digest(path)
        if pending(json.loads(path.read_text())):
            raise RuntimeError('A pending transaction must be reconciled before an image update')


def snapshot():
    settings = json.loads((CONFIG / 'settings.json').read_text())
    if (settings.get('mode') != 'execute' or settings.get('networkMode') != 'mainnet'
            or set(settings.get('execution', {})) != {'42161'}):
        raise RuntimeError('Expected the existing owner-enabled Arbitrum pilot only')
    if any(p.is_symlink() for p in CONFIG.rglob('*')):
        raise RuntimeError('Unexpected configuration symlink')
    hashes = {str(p): digest(p) for p in CONFIG.rglob('*')
              if p.is_file() and p.name != 'image.env'}
    hashes[str(RUNNER)] = digest(RUNNER)
    status = get('/v1/status')
    if (status.get('mode') != 'execute' or status.get('network') != 'mainnet'
            or [x.get('chainId') for x in status.get('chains', [])] != [42161]):
        raise RuntimeError('The running service does not match the existing pilot scope')
    if not isinstance(status.get('economics'), dict) or not isinstance(status.get('operatingControl'), dict):
        raise RuntimeError('Economic and operator control state must be available')
    if status['economics'].get('pending'):
        raise RuntimeError('Pending transaction history must be reconciled first')
    check_journal()
    policies = []
    for endpoint in ['/v1/markets', '/v1/aqua-markets']:
        for row in get(endpoint).get('markets', []):
            if row.get('policy') is not None:
                identity = row.get('market', row.get('pool', {}))
                policies.append(json.dumps({'endpoint': endpoint, 'identity': identity.get('stableStrategyId', identity.get('poolId')), 'policy': row['policy']}, sort_keys=True))
    return {'hashes': hashes, 'policies': sorted(policies),
            'operatingControl': status['operatingControl'],
            'economics': status['economics'],
            'historyCount': get('/v1/executions?network=mainnet&limit=1')['matchedCount']}


def write_pin(value):
    target = CONFIG / 'image.env'
    temp = CONFIG / ('image.env.upgrade-' + str(os.getpid()))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write('IMAGE_ID=' + value + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, target)
    finally:
        if temp.exists():
            temp.unlink()


def probe(expected_hash):
    path = BUILD / 'host-readonly-probe.mjs'
    if digest(path) != expected_hash:
        raise RuntimeError('Read-only validation program differs from reviewed bytes')
    path.chmod(0o644)
    secret = json.loads((CONFIG / 'observer.json').read_text())
    args = ['docker', 'run', '--rm', '-i', '--network', 'aqua0-rebalancer-isolated',
            '--cpus', '0.50', '--memory', '512m', '--memory-swap', '512m', '--pids-limit', '128',
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--entrypoint', 'node', '--mount', 'type=bind,src=' + str(path) + ',dst=/app/probe.mjs,readonly', NEW, '/app/probe.mjs']
    pilot = json.loads((BUILD / 'source/config/arbitrum-pilot.json').read_text())
    rows = get('/v1/aqua-markets').get('markets', [])
    chosen = next((row for row in rows if row.get('market', {}).get('stableStrategyId', '').lower() == pilot['strategyId'].lower()), None)
    if not chosen or not chosen.get('readyToQuote') or not (chosen.get('policy') or {}).get('approved'):
        raise RuntimeError('The currently approved pilot strategy must be available for the read-only check')
    payload = {'readKey': secret['AQUA0_READ_API_KEY'], 'settings': json.loads((CONFIG / 'settings.json').read_text()), 'policy': chosen['policy']}
    result = subprocess.run(args, input=json.dumps(payload),
                            text=True, capture_output=True, timeout=100)
    if result.returncode:
        raise RuntimeError('Read-only image validation did not complete; active service unchanged')
    answer = json.loads(result.stdout)
    if (answer.get('sourceCommit') != SOURCE or answer.get('signatures') != 0
            or answer.get('transactions') != 0 or answer.get('liveSettingsChanged') is not False):
        raise RuntimeError('Invalid read-only validation receipt')
    return answer


def main(request):
    if set(request) != {'action', 'confirmed', 'probeHash'} or request['action'] not in ['status', 'apply']:
        raise RuntimeError('Invalid image repair request')
    if not re.fullmatch('[a-f0-9]{64}', request['probeHash']):
        raise RuntimeError('Invalid probe identity')
    if request['action'] == 'apply' and request['confirmed'] is not True:
        raise RuntimeError('Explicit interactive owner confirmation is required')
    if run(['systemctl', 'is-active', UNIT]) != 'active':
        raise RuntimeError('The existing worker service is not active')
    current = run(['docker', 'inspect', '--format', '{{.Image}}', CONTAINER])
    if current not in [OLD, NEW] or (CONFIG / 'image.env').read_text().strip() != 'IMAGE_ID=' + current:
        raise RuntimeError('Another release changed the running image; do not overwrite it')
    record = json.loads((BUILD / 'build-complete.json').read_text())
    if record.get('sourceCommit') != SOURCE or record.get('image') != NEW:
        raise RuntimeError('Missing exact-source image build evidence')
    if run(['docker', 'image', 'inspect', '--format', '{{.Id}}', NEW]) != NEW:
        raise RuntimeError('Verified repair image is unavailable')
    if current == NEW:
        status = get('/v1/status')
        return {'state': 'already-updated', 'image': NEW, 'mode': status.get('mode'), 'changed': False, 'pending': (status.get('economics') or {}).get('pending')}
    before = snapshot()
    if request['action'] == 'status':
        return {'state': 'ready-for-owner-validation', 'currentImage': OLD, 'repairImage': NEW,
                'mode': 'execute', 'changed': False, 'liveTimingVerified': False}
    validations = []
    for _ in range(2):
        validation = probe(request['probeHash'])
        validations.append(validation)
        if validation.get('finalProofFresh') is not True or validation.get('withinCurrentTaskBudget') is not True:
            return {'state': 'validation-blocked', 'changed': False, 'validation': validation, 'validationAttempts': len(validations)}
    validation['previousPipelineMs'] = validations[0].get('pipelineMs')
    # The probe must not overwrite any concurrent owner edit or transaction.
    if snapshot() != before:
        raise RuntimeError('Worker state changed during preflight; leave the current service alone')
    if (run(['docker', 'inspect', '--format', '{{.Image}}', CONTAINER]) != OLD
            or (CONFIG / 'image.env').read_text().strip() != 'IMAGE_ID=' + OLD):
        raise RuntimeError('Another image changed during validation')
    backup = BACKUPS / ('refresh-' + str(time.time_ns()))
    backup.mkdir(mode=0o700, parents=True)
    old_pin = (CONFIG / 'image.env').read_bytes()
    (backup / 'image.env').write_bytes(old_pin)
    stopped = False
    try:
        run(['systemctl', 'stop', UNIT], timeout=70)
        stopped = True
        check_journal()
        if any(p.is_symlink() for p in DATA.rglob('*')):
            raise RuntimeError('Unexpected runtime symlink')
        for name, expected in before['hashes'].items():
            if digest(Path(name)) != expected:
                raise RuntimeError('Configuration changed while stopping the worker')
        if (CONFIG / 'image.env').read_bytes() != old_pin:
            raise RuntimeError('Image pin changed during upgrade')
        shutil.copytree(DATA, backup / 'runtime')
        write_pin(NEW)
        run(['systemctl', 'start', UNIT], timeout=60)
        deadline = time.monotonic() + 45
        while True:
            try:
                after = get('/v1/status')
                if after.get('mode') == 'execute' and after.get('network') == 'mainnet':
                    break
            except Exception:
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError('Repair image did not expose its runtime status')
            time.sleep(1)
        if run(['docker', 'inspect', '--format', '{{.Image}}', CONTAINER]) != NEW:
            raise RuntimeError('Wrong worker image started')
        for name, expected in before['hashes'].items():
            if digest(Path(name)) != expected:
                raise RuntimeError('Configuration was altered during the image update')
        if after.get('operatingControl') != before['operatingControl']:
            raise RuntimeError('Operator pause state unexpectedly changed')
        # Do not compare/restore history after start: the owner-enabled bot may now send a trade.
        return {'state': 'updated', 'sourceCommit': SOURCE, 'image': NEW, 'mode': after['mode'],
                'settingsAndCredentialsUnchanged': True, 'historyRestored': False,
                'backupPath': str(backup), 'validation': validation,
                'note': 'Only the image changed. The owner-enabled bot may now trade within existing limits.'}
    except Exception:
        if stopped:
            # Only code rollback. Never overwrite runtime files or erase a newly pending transaction.
            try:
                run(['systemctl', 'stop', UNIT], timeout=70)
                pin = (CONFIG / 'image.env').read_text().strip()
                if pin not in ['IMAGE_ID=' + OLD, 'IMAGE_ID=' + NEW]:
                    raise RuntimeError('Concurrent image edit requires manual review')
                write_pin(OLD)
                run(['systemctl', 'start', UNIT], timeout=60)
            except Exception:
                raise RuntimeError('Upgrade/rollback uncertain; preserve all runtime data and inspect service status')
        raise
