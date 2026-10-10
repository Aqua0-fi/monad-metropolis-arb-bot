#!/usr/bin/env python3
"""Owner-confirmed receipt repair and code update; never signs or sends a transaction."""
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
from pathlib import Path

CONFIG = Path('/etc/aqua0-market-rebalancer')
DATA = Path('/var/lib/aqua0-market-rebalancer')
BACKUPS = Path('/var/lib/aqua0-market-rebalancer-backups')
BUILD_ROOT = Path('/home/ubuntu/market-rebalancer-builds')
RUNNER = Path('/opt/aqua0-market-rebalancer/run-observer-container.sh')
UNIT = 'aqua0-market-rebalancer.service'
CONTAINER = 'aqua0-market-rebalancer'
OLD_IMAGES = {
    'sha256:4ffa8e6394f59a80a1fd2caf84246878db89e974609ae4e6362cc547f3592312',
    'sha256:23d2b8bba286faad7066f60962c8b922b0cd187d8ba1ebdc45316f842eb0c421',
}


def run(args, timeout=30):
    p = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError('Host check failed: ' + args[0])
    return p.stdout.strip()


def file_hash(path):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError('Unexpected settings/runtime file type')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_record(tx):
    db = DATA / 'history.sqlite'
    file_hash(db)
    conn = sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)
    try:
        row = conn.execute('SELECT payload FROM executions WHERE network=? AND chain_id=? AND transaction_hash=?',
                           ('mainnet', 42161, tx.lower())).fetchone()
        if not row:
            raise RuntimeError('The exact existing execution history is required')
        return json.loads(row[0])
    finally:
        conn.close()


def current_entry(settings, tx):
    path = DATA / 'journal.json'
    file_hash(path)
    journal = json.loads(path.read_text())
    operator = settings['execution']['42161']['operator'].lower()
    key = '42161:' + operator
    if any(value.get('pending') for account, value in journal.items() if account != key):
        raise RuntimeError('Another pending account requires separate reconciliation')
    entry = journal.get(key)
    if not isinstance(entry, dict):
        raise RuntimeError('The existing operator journal is required')
    pending = entry.get('pending')
    if pending and pending.get('hash', '').lower() != tx.lower():
        raise RuntimeError('Another transaction replaced the requested pending hash')
    record = read_record(tx)
    if (record.get('operator') != operator or record.get('executor') != settings['execution']['42161']['executor'].lower()
            or (pending and record.get('tradeId') != pending.get('id'))):
        raise RuntimeError('History, journal and configured account identities disagree')
    if not pending and (record.get('status') not in ['confirmed', 'reverted'] or not record.get('receipt')):
        raise RuntimeError('A missing pending entry cannot be repaired from guessed history')
    return entry, record


def write_pin(image):
    target = CONFIG / 'image.env'
    temp = CONFIG / ('image.env.receipt-' + str(os.getpid()))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        out.write('IMAGE_ID=' + image + '\n')
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp, target)


def recovery_container(image, tx, rpc_url):
    args = ['docker', 'run', '--rm', '-i', '--network', 'aqua0-rebalancer-isolated',
            '--cpus', '0.50', '--memory', '512m', '--memory-swap', '512m', '--pids-limit', '128',
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--env', 'AWS_EC2_METADATA_DISABLED=true',
            '--mount', 'type=bind,src=' + str(DATA) + ',dst=/app/runtime',
            '--mount', 'type=bind,src=' + str(CONFIG / 'settings.json') + ',dst=/etc/rebalancer/settings.json,readonly',
            image, 'node', 'dist/src/receipt-recovery.js', '--config', '/etc/rebalancer/settings.json',
            '--chain', '42161', '--transaction', tx, '--apply']
    # Keep the image's flock entrypoint: a still-running worker must exclude this process.
    p = subprocess.run(args, input=json.dumps({'rpcUrl': rpc_url}), text=True, capture_output=True, timeout=120)
    try:
        answer = json.loads(p.stdout)
    except (ValueError, TypeError):
        raise RuntimeError('Receipt recovery did not return a valid result; worker remains stopped')
    if p.returncode or answer.get('state') != 'reconciled':
        reason = answer.get('reason', 'receipt verification failed')
        raise RuntimeError('Receipt recovery refused: ' + str(reason)[:350])
    if (answer.get('signatures') != 0 or answer.get('transactions') != 0
            or answer.get('transactionHash', '').lower() != tx.lower()
            or answer.get('network') != 'mainnet' or answer.get('chainId') != 42161
            or answer.get('journalReleased') is not True
            or not (answer.get('receipt') or {}).get('feeValuation')):
        raise RuntimeError('Incomplete recovery proof; worker remains stopped')
    return answer


def main(request):
    if set(request) != {'confirmed', 'image', 'source', 'transaction', 'rpcUrl'} or request['confirmed'] is not True:
        raise RuntimeError('Explicit interactive owner confirmation is required')
    image, source, tx = request['image'], request['source'], request['transaction']
    if (not re.fullmatch(r'sha256:[a-f0-9]{64}', image) or not re.fullmatch(r'[a-f0-9]{40}', source)
            or not re.fullmatch(r'0x[0-9a-fA-F]{64}', tx)):
        raise RuntimeError('Invalid release or transaction identity')
    if not isinstance(request['rpcUrl'], str) or not request['rpcUrl'].startswith('https://'):
        raise RuntimeError('An existing authenticated mainnet HTTPS RPC is required')
    build = BUILD_ROOT / ('20260929-receipt-' + source[:7])
    record = json.loads((build / 'build-complete.json').read_text())
    if record.get('sourceCommit') != source or record.get('image') != image:
        raise RuntimeError('Exact-source build receipt does not match requested image')
    if run(['docker', 'image', 'inspect', '--format', '{{.Id}}', image]) != image:
        raise RuntimeError('Verified image is missing')
    pin = CONFIG / 'image.env'
    old_pin = pin.read_bytes()
    old_image = old_pin.decode().strip().removeprefix('IMAGE_ID=')
    if old_image not in OLD_IMAGES | {image}:
        raise RuntimeError('Another image has been selected; do not overwrite it')
    settings = json.loads((CONFIG / 'settings.json').read_text())
    if (settings.get('mode') != 'execute' or settings.get('networkMode') != 'mainnet'
            or set(settings.get('execution', {})) != {'42161'}):
        raise RuntimeError('Only the existing owner-enabled Arbitrum pilot may be repaired')
    if any(p.is_symlink() for p in CONFIG.rglob('*')) or any(p.is_symlink() for p in DATA.rglob('*')):
        raise RuntimeError('Unexpected runtime or configuration symlink')
    protected = {str(p): file_hash(p) for p in CONFIG.rglob('*') if p.is_file() and p != pin}
    protected[str(RUNNER)] = file_hash(RUNNER)
    entry, saved = current_entry(settings, tx)
    before_entry = json.dumps(entry, sort_keys=True)
    active = run(['systemctl', 'show', UNIT, '--property=ActiveState', '--value']) == 'active'
    if active and run(['docker', 'inspect', '--format', '{{.Image}}', CONTAINER]) != old_image:
        raise RuntimeError('Active service and image pin disagree')
    backup = BACKUPS / ('receipt-recovery-' + str(time.time_ns()))
    backup.mkdir(mode=0o700, parents=True)
    (backup / 'image.env').write_bytes(old_pin)
    stopped = not active
    try:
        if active:
            run(['systemctl', 'stop', UNIT], timeout=70)
            stopped = True
        for name, expected in protected.items():
            if file_hash(Path(name)) != expected:
                raise RuntimeError('Configuration changed before the recovery')
        if pin.read_bytes() != old_pin or json.dumps(current_entry(settings, tx)[0], sort_keys=True) != before_entry:
            raise RuntimeError('Image or journal changed during preflight')
        shutil.copytree(DATA, backup / 'runtime')
        result = recovery_container(image, tx, request['rpcUrl'])
        after_entry, after_record = current_entry(settings, tx)
        if after_entry.get('pending') or after_record['status'] != result['status']:
            raise RuntimeError('Recovery did not persist the verified final state')
        if after_entry.get('reservedWei') != entry.get('reservedWei') or after_entry.get('day') != entry.get('day'):
            raise RuntimeError('Recovery changed the existing daily reservation')
        for name, expected in protected.items():
            if file_hash(Path(name)) != expected:
                raise RuntimeError('Protected configuration changed during receipt maintenance')
        write_pin(image)
        run(['systemctl', 'start', UNIT], timeout=60)
        if run(['systemctl', 'show', UNIT, '--property=ActiveState', '--value']) != 'active':
            raise RuntimeError('Updated worker did not restart')
        deadline = time.monotonic() + 25
        while True:
            try:
                actual = run(['docker', 'inspect', '--format', '{{.Image}} {{.State.Running}}', CONTAINER])
                if actual == image + ' true':
                    break
            except RuntimeError:
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError('The verified worker image did not become active')
            time.sleep(1)
        # Existing economic/operator pauses remain enforced by the unchanged worker settings.
        return {'state': 'reconciled-and-updated', 'image': image, 'sourceCommit': source,
                'transactionHash': tx, 'recovery': result, 'backupPath': str(backup),
                'settingsAndCredentialsUnchanged': True, 'signaturesByRecovery': 0,
                'transactionsByRecovery': 0, 'note': 'The original owner-enabled worker is resumed; no profit withdrawal or new funding was requested.'}
    except Exception:
        if stopped:
            # Never restore stale runtime data or restart old code after a partially committed recovery.
            try:
                run(['systemctl', 'stop', UNIT], timeout=70)
            except Exception:
                pass
        raise
