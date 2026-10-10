#!/usr/bin/env python3
"""Owner-start helper over authenticated SSH. Default action is read-only preflight.

This is not a daemon and is not called by an observer upgrade. It never signs a
transaction, clears a journal, withdraws inventory or changes another service.
"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = Path('/etc/aqua0-market-rebalancer')
DATA = Path('/var/lib/aqua0-market-rebalancer')
BACKUPS = Path('/var/lib/aqua0-market-rebalancer-backups')
RUNNER = Path('/opt/aqua0-market-rebalancer/run-observer-container.sh')
UNIT = 'aqua0-market-rebalancer.service'
CONTAINER = 'aqua0-market-rebalancer'


def run(args, timeout=40):
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError('A scoped host command failed; no success is assumed')
    return p.stdout.strip()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


opener = urllib.request.build_opener(NoRedirect, urllib.request.ProxyHandler({}))


def report(path, body=None):
    secrets = json.loads((ROOT / 'observer.json').read_text())
    key = 'REBALANCER_CONTROL_TOKEN' if body is not None else 'REBALANCER_REPORT_TOKEN'
    token = secrets[key]
    request = urllib.request.Request('http://127.0.0.1:9191' + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json'})
    with opener.open(request, timeout=15) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise RuntimeError('Oversized local report')
    return json.loads(raw)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pending(value):
    if isinstance(value, dict):
        return bool(value.get('pending')) or any(pending(x) for x in value.values())
    if isinstance(value, list):
        return any(pending(x) for x in value)
    return False


def write_private(path, content, uid=0, gid=0, mode=0o600):
    if path.is_symlink():
        raise RuntimeError('Refusing a symlinked configuration file')
    temp = path.with_name(path.name + '.owner-pilot-tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chown(temp, uid, gid)
        os.chmod(temp, mode)
        os.replace(temp, path)
        d = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(d)
        finally:
            os.close(d)
    finally:
        if temp.exists():
            temp.unlink()


def state(expected):
    settings_path = ROOT / 'settings.json'
    if settings_path.is_symlink() or RUNNER.is_symlink():
        raise RuntimeError('Unexpected configuration symlink')
    settings = json.loads(settings_path.read_text())
    image = run(['docker', 'inspect', '--format', '{{.Image}}', CONTAINER])
    if image != expected['image']:
        raise RuntimeError('The tested pilot image is not the currently running image')
    if settings.get('apiUrl') != 'https://staging-api.aqua0.xyz' or settings.get('networkMode', 'mainnet') != 'mainnet':
        raise RuntimeError('Pilot must use the reviewed staging API and Arbitrum mainnet')
    if set(settings.get('execution', {})) - {'42161'}:
        raise RuntimeError('Other chain execution configuration must not be replaced')
    command = json.loads(run(['docker', 'inspect', '--format', '{{json .Config.Cmd}}', CONTAINER]))
    if command[-2:] != ['--chain', '42161']:
        raise RuntimeError('The running worker is not restricted to Arbitrum')
    status = report('/v1/status')
    v4 = report('/v1/markets')
    aqua = report('/v1/aqua-markets')
    for row in v4.get('markets', []):
        if isinstance(row.get('policy'), dict) and row['policy'].get('approved'):
            raise RuntimeError('An existing V4 approval is outside this one-route pilot')
    chosen = None
    for row in aqua.get('markets', []):
        market = row['market']
        if market['chainId'] == 42161 and market['stableStrategyId'].lower() == expected['strategyId'].lower():
            chosen = row
        elif isinstance(row.get('policy'), dict) and row['policy'].get('approved'):
            raise RuntimeError('Another strategy is already approved; refusing to overwrite its operating scope')
    if not chosen or not chosen.get('present') or chosen.get('blockers'):
        raise RuntimeError('The reviewed strategy is not currently available in the worker catalog')
    market = chosen['market']
    if market['maker'].lower() != expected['maker'].lower() or str(market['classId']) != str(expected['classId']):
        raise RuntimeError('Discovered maker/class differs from the reviewed pilot')
    control = status.get('operatingControl')
    economics = status.get('economics')
    if not isinstance(control, dict) or not isinstance(economics, dict):
        raise RuntimeError('Operating or economic safety state is unavailable')
    if economics.get('blocked') or economics.get('pending', 0):
        raise RuntimeError('An economic pause or unresolved execution requires explicit review')
    if control.get('paused') or 42161 in control.get('pausedChains', []):
        raise RuntimeError('An operator pause must be reviewed explicitly, not cleared by setup')
    journal = DATA / 'journal.json'
    if journal.exists() and pending(json.loads(journal.read_text())):
        raise RuntimeError('A pending transaction must be reconciled before a setup or restart')
    return settings, status, chosen


def await_status(mode):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            status = report('/v1/status')
            if status.get('mode') == mode:
                return status
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('Worker did not return a verified status after restart')


def main(request):
    action = request.get('action', 'preflight')
    p = request['policy']
    if p['chainId'] != 42161 or int(p['maxInput']) > 5000000 or int(p['inventoryTarget']) > 5000000:
        raise RuntimeError('Pilot chain/capital scope mismatch')
    settings, status, chosen = state(p)
    source_settings_hash = digest(ROOT / 'settings.json')
    source_runner_hash = digest(RUNNER)
    if action == 'preflight':
        return {'mode': status['mode'], 'image': p['image'], 'strategyPresent': True,
                'configuredMarkets': status.get('configuredMarkets'), 'settingsHash': digest(ROOT / 'settings.json'),
                'storedExecutions': report('/v1/executions?limit=1')['matchedCount'],
                'executionEnabled': any(row.get('executionEnabled') for row in status['chains'])}
    if request.get('ownerConfirmation') != 'START ARBITRUM 5 USDC':
        raise RuntimeError('Explicit owner invocation is required')
    if action not in ('stage', 'activate'):
        raise RuntimeError('Unsupported owner operation')
    if settings.get('mode') == 'execute':
        if settings.get('execution', {}).get('42161') == {**request['execution'], 'allowBroadcast': True}:
            return {'mode': 'execute', 'alreadyActive': True, 'fundsMovedByHostHelper': False}
        raise RuntimeError('Another live execution configuration must not be overwritten')
    if settings.get('mode') != 'observe':
        raise RuntimeError('Expected the existing observe-only worker')
    execution = request['execution']
    if execution.get('allowBroadcast') is not False or execution.get('externalPools') != [p['externalPool']] or \
            execution['executor'].lower() != p['executor'].lower() or execution['operator'].lower() != p['owner'].lower() or \
            int(execution['maxDailyGasWei']) > int(p['maxDailyGasWei']) or int(execution['liveFeeBufferBps']) != 10500:
        raise RuntimeError('Execution settings exceed the reviewed pilot')
    if action == 'stage':
        credentials = request['credentials']
        if set(credentials) - {'accessKeyId', 'secretAccessKey', 'sessionToken', 'expiration'} or \
                not credentials.get('accessKeyId') or not credentials.get('secretAccessKey'):
            raise RuntimeError('Missing dedicated signer credentials')
        # This is the existing dedicated KMS credential, never an ambient administrator session.
        owner = (ROOT / 'observer.json').stat()
        runner = RUNNER.read_text()
        if 'REBALANCER_AWS_CREDENTIALS_FILE=' not in runner:
            anchor = '  --env AWS_EC2_METADATA_DISABLED=true'
            if runner.count(anchor) != 1:
                raise RuntimeError('Installed observer runner changed; refusing a blind edit')
            runner = runner.replace(anchor,
                '  --env REBALANCER_AWS_CREDENTIALS_FILE=/run/secrets/signer/aws.json \\\n'
                '  --mount type=bind,src=/etc/aqua0-market-rebalancer/signer,dst=/run/secrets/signer,readonly \\\n' + anchor, 1)
        backup = BACKUPS / ('owner-pilot-' + str(time.time_ns()))
        backup.mkdir(mode=0o700)
        run(['systemctl', 'stop', UNIT], 70)
        try:
            if digest(ROOT / 'settings.json') != source_settings_hash or digest(RUNNER) != source_runner_hash:
                raise RuntimeError('Runtime configuration changed concurrently; no overwrite performed')
            if any(path.is_symlink() for path in DATA.rglob('*')):
                raise RuntimeError('Runtime contains a symlink; refusing an unsafe backup')
            shutil.copytree(DATA, backup / 'runtime', symlinks=False)
            shutil.copy2(ROOT / 'settings.json', backup / 'settings.json')
            shutil.copy2(RUNNER, backup / 'run-observer-container.sh')
            signer_dir = ROOT / 'signer'
            if signer_dir.is_symlink():
                raise RuntimeError('Signer directory cannot be a symlink')
            signer_dir.mkdir(mode=0o700, exist_ok=True)
            os.chown(signer_dir, owner.st_uid, owner.st_gid)
            os.chmod(signer_dir, 0o700)
            write_private(signer_dir / 'aws.json', json.dumps(credentials).encode(), owner.st_uid, owner.st_gid)
            settings['execution'] = {'42161': execution}
            settings['mode'] = 'observe'
            write_private(ROOT / 'settings.json', (json.dumps(settings, indent=2) + '\n').encode(), mode=0o644)
            write_private(RUNNER, runner.encode())
            os.chmod(RUNNER, 0o755)
        finally:
            run(['systemctl', 'start', UNIT], 60)
        await_status('observe')
        # The following constructs the account by GetPublicKey only. It does not sign a digest.
        check = "import {loadSettings} from './dist/src/config.js';import {workerAccount} from './dist/src/worker-account.js';const s=loadSettings('/etc/rebalancer/settings.json');const a=await workerAccount(42161,s.execution['42161']);console.log(JSON.stringify({address:a.address,signatures:0}));"
        verified = json.loads(run(['docker', 'exec', CONTAINER, 'node', '--input-type=module', '-e', check]))
        if verified['address'].lower() != p['owner'].lower() or verified['signatures'] != 0:
            raise RuntimeError('Dedicated runtime signer did not resolve to the owner wallet')
        # Discovery can refresh during restart; use its actual current version, never a stale guess.
        _, _, current = state(p)
        previous = current.get('policy') or {}
        desired = {'approved': True, 'classId': str(p['classId']), 'baseToken': p['baseToken'],
                   'maxInput': str(p['maxInput']), 'minNetProfit': str(p['minNetProfit']),
                   'amounts': [], 'note': 'Owner-enabled Arbitrum pilot. Profits stay in executor; LP returns are manual.'}
        if any(previous.get(k) != v for k, v in desired.items()):
            report('/v1/aqua-markets/42161/' + p['strategyId'] + '/policy',
                   {'network': 'mainnet', 'actor': 'owner:' + p['owner'],
                    'policy': {**desired, 'expectedVersion': previous.get('version', 0)}})
        return {'mode': 'observe', 'runtimeSignerVerified': True, 'signatures': 0,
                'approvedStrategies': 1, 'backup': str(backup), 'tradingEnabled': False}
    # Activation is a separate owner-invoked phase after confirmed onchain setup and inventory.
    if request.get('onchainVerified') is not True:
        raise RuntimeError('Confirmed onchain setup is required before activation')
    if settings.get('execution', {}).get('42161') != execution:
        raise RuntimeError('Staged execution settings changed')
    if not chosen.get('policy', {}).get('approved') or int(chosen['policy']['maxInput']) != int(p['maxInput']):
        raise RuntimeError('Reviewed market policy is not in force')
    if digest(ROOT / 'settings.json') != source_settings_hash:
        raise RuntimeError('Runtime configuration changed before activation')
    settings['mode'] = 'execute'
    settings['execution']['42161']['allowBroadcast'] = True
    run(['systemctl', 'stop', UNIT], 70)
    try:
        write_private(ROOT / 'settings.json', (json.dumps(settings, indent=2) + '\n').encode(), mode=0o644)
        run(['systemctl', 'start', UNIT], 60)
        active = await_status('execute')
        enabled = [row['chainId'] for row in active['chains'] if row.get('executionEnabled')]
        if enabled != [42161]:
            raise RuntimeError('Unexpected live chain scope')
        return {'mode': 'execute', 'executionEnabledChains': enabled, 'approvedStrategies': 1,
                'maxInputUsdc': '5', 'profitRecipient': p['executor'], 'automaticLpReturns': False}
    except Exception:
        # Keep the account configuration for reconciliation. Never clear a hash/history after a possible send.
        settings['mode'] = 'observe'
        settings['execution']['42161']['allowBroadcast'] = False
        run(['systemctl', 'stop', UNIT], 70)
        write_private(ROOT / 'settings.json', (json.dumps(settings, indent=2) + '\n').encode(), mode=0o644)
        run(['systemctl', 'start', UNIT], 60)
        raise


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(32769)
        if len(raw) > 32768:
            raise RuntimeError('Oversized owner request')
        print(json.dumps(main(json.loads(raw))))
    except Exception as error:
        # Input includes credentials in owner-only staging mode; never print the input or a traceback.
        print(json.dumps({'error': str(error) if isinstance(error, RuntimeError) else type(error).__name__,
                          'completed': False}), file=sys.stderr)
        raise SystemExit(1)
