#!/usr/bin/env python3
"""One bounded host-health sample. No process restarts and no secrets in reports or alerts."""
import datetime
import json
import os
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path


def timestamp(now):
    return datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


def cpu_sample(text):
    line = next(line for line in text.splitlines() if line.startswith('cpu '))
    # Guest time is already included in user/nice; counting it twice understates pressure.
    numbers = [int(v) for v in line.split()[1:9]]
    return {'total': sum(numbers), 'idle': numbers[3] + numbers[4]}


def cpu_percent(before, after):
    elapsed = after['total'] - before['total']
    idle = after['idle'] - before['idle']
    if elapsed <= 0 or idle < 0:
        return None
    return max(0.0, min(100.0, 100.0 * (elapsed - idle) / elapsed))


def pressure_candidates(metrics, containers, services):
    found = {}
    if metrics['cpuPercent'] >= 85:
        found['cpu'] = ('warning', 'CPU utilization has remained at or above 85%.')
    available, total = metrics['memoryAvailableBytes'], metrics['memoryTotalBytes']
    if available < max(512 * 1024**2, total * .08):
        found['memory'] = ('critical', 'Available host memory is below the safe monitoring threshold.')
    if metrics['diskUsedPercent'] >= 90 or metrics['diskFreeBytes'] < 5 * 1024**3:
        found['disk'] = ('critical', 'Host root disk is nearly full or has less than 5 GiB free.')
    if not metrics['workerResponsive']:
        found['worker-http'] = ('critical', 'The market-rebalancer health endpoint is not responding successfully.')
    age = metrics['workerProgressAgeSeconds']
    if age is None or age > 180:
        found['worker-stall'] = ('critical', 'The market-rebalancer loop has not reported progress for more than three minutes.')
    for kind, items in [('container', containers), ('service', services)]:
        for item in items:
            if not item['healthy']:
                found[kind + ':' + item['name']] = ('critical', 'Expected ' + kind + ' ' + item['name'] + ' is ' + item['state'] + '.')
    return found


def advance_alerts(previous, candidates, now, sustained_samples=3):
    result = {}
    recovered = []
    for key, (severity, message) in candidates.items():
        old = previous.get(key, {})
        result[key] = {'count': old.get('count', 0) + 1, 'since': old.get('since', timestamp(now)),
                       'severity': severity, 'message': message,
                       'active': old.get('count', 0) + 1 >= sustained_samples}
    for key, old in previous.items():
        if old.get('active') and key not in candidates:
            recovered.append(key)
    alerts = [{'id': key, 'severity': item['severity'], 'message': item['message'], 'since': item['since']}
              for key, item in sorted(result.items()) if item['active']]
    return result, alerts, recovered


def atomic_json(path, data, mode=0o600):
    path = Path(path)
    temp = path.with_name(path.name + '.new')
    with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode), 'w') as out:
        json.dump(data, out, indent=2)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())
    os.chmod(temp, mode)
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def run(args, timeout=8):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=True).stdout


def inspect_containers(expected):
    if not expected:
        return []
    # One metadata call; never inspect container environment, commands, mounts or credentials.
    raw = run(['docker', 'ps', '-a', '--format', '{"Names":{{json .Names}},"State":{{json .State}},"Status":{{json .Status}}}'])
    states = {row['Names']: row for row in (json.loads(line) for line in raw.splitlines() if line)}
    result = []
    for name in expected:
        row = states.get(name)
        state = row.get('State', 'unknown') if row else 'missing'
        status = row.get('Status', '') if row else ''
        healthy = state == 'running' and '(unhealthy)' not in status and '(health: starting)' not in status
        result.append({'name': name, 'state': 'unhealthy' if '(unhealthy)' in status else state, 'healthy': healthy})
    return result


def inspect_services(expected):
    result = []
    for name in expected:
        try:
            state = run(['systemctl', 'show', name, '--property=ActiveState', '--value'], 3).strip()
        except Exception:
            state = 'unknown'
        result.append({'name': name, 'state': state, 'healthy': state == 'active'})
    return result


def worker_health(port, now):
    try:
        # Proxy settings cannot redirect this local liveness probe to an external service.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open('http://127.0.0.1:' + str(port) + '/health', timeout=4) as response:
            data = json.loads(response.read(65537))
            if response.status != 200:
                return False, None
        last = data.get('lastHeartbeat')
        age = max(0, now - float(last) / 1000) if isinstance(last, (float, int)) else None
        return True, age
    except Exception:
        return False, None


def maybe_notify(state, alerts, recovered, config, now):
    topic = os.environ.get('WATCHDOG_SNS_TOPIC_ARN')
    today = timestamp(now)[:10]
    if state.get('notificationDay') != today:
        state['notificationDay'], state['notificationsToday'] = today, 0
    ids = sorted(a['id'] for a in alerts)
    changed = ids != state.get('notifiedAlerts', [])
    due = changed or (alerts and now - state.get('lastNotification', 0) >= 21600)
    if not topic or not due or state.get('notificationsToday', 0) >= 12 or now - state.get('lastNotification', 0) < 900:
        return
    # boto3 is isolated in this watchdog's venv. Explicit AWS credentials belong only to an SNS publisher.
    try:
        import boto3
        from botocore.config import Config
        client = boto3.client('sns', region_name=config.get('region', 'us-east-1'),
                              config=Config(connect_timeout=4, read_timeout=8, retries={'max_attempts': 1}))
        lines = ['Aqua0 existing-host health at ' + timestamp(now),
                 'No automatic restarts were performed.', '']
        lines += [a['severity'].upper() + ': ' + a['message'] for a in alerts]
        if not alerts:
            lines.append('Previously reported sustained alerts have cleared.')
        client.publish(TopicArn=topic, Subject='Aqua0 host health: ' + ('attention needed' if alerts else 'recovered'),
                       Message='\n'.join(lines))
        state['lastNotification'], state['notifiedAlerts'] = now, ids
        state['notificationsToday'] = state.get('notificationsToday', 0) + 1
        state['notificationError'] = None
    except Exception:
        state['notificationError'] = 'SNS publish unavailable; local health reporting remains active.'
        # Back off even on transport failure; never burn credits in an exception loop.
        state['lastNotification'] = now


def sample(config, state, now):
    before = cpu_sample(Path('/proc/stat').read_text())
    time.sleep(.25)
    after = cpu_sample(Path('/proc/stat').read_text())
    previous_cpu = state.get('cpu') if 0 < now - state.get('lastSample', 0) < 180 else None
    cpu = cpu_percent(previous_cpu or before, after)
    state['cpu'] = after
    if cpu is None:
        raise RuntimeError('CPU sample is unavailable')
    mem = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        mem[key] = int(value.split()[0]) * 1024
    disk = shutil.disk_usage('/')
    responsive, age = worker_health(config['workerPort'], now)
    containers = inspect_containers(config['containers'])
    services = inspect_services(config['services'])
    metrics = {'cpuPercent': round(cpu, 2), 'load1': os.getloadavg()[0], 'cpuCount': os.cpu_count() or 1,
               'memoryAvailableBytes': mem['MemAvailable'], 'memoryTotalBytes': mem['MemTotal'],
               'diskFreeBytes': disk.free, 'diskUsedPercent': round(100 * disk.used / disk.total, 2),
               'workerResponsive': responsive, 'workerProgressAgeSeconds': round(age, 2) if age is not None else None}
    previous = state.get('pendingAlerts', {}) if now - state.get('lastSample', 0) <= 180 else {}
    pending, alerts, recovered = advance_alerts(previous, pressure_candidates(metrics, containers, services), now)
    state['pendingAlerts'], state['lastSample'] = pending, now
    maybe_notify(state, alerts, recovered, config, now)
    return {'version': 1, 'available': True, 'checkedAt': timestamp(now), 'metrics': metrics,
            'alerts': alerts, 'containers': containers, 'services': services,
            'notification': {'configured': bool(os.environ.get('WATCHDOG_SNS_TOPIC_ARN')), 'error': state.get('notificationError')}}


def main():
    config_path = Path(os.environ.get('WATCHDOG_CONFIG', '/etc/aqua0-host-watchdog/config.json'))
    config = json.loads(config_path.read_text())
    directory = Path(config['stateDirectory'])
    if not directory.is_dir() or directory.is_symlink():
        raise RuntimeError('Configured state directory must already exist and must not be a symlink')
    state_file, report_file = directory / 'state.json', directory / 'health.json'
    state = json.loads(state_file.read_text()) if state_file.exists() else {}
    try:
        report = sample(config, state, time.time())
    except Exception:
        report = {'version': 1, 'available': False, 'checkedAt': timestamp(time.time()),
                  'reason': 'The watchdog could not complete a bounded host sample.'}
    atomic_json(state_file, state)
    atomic_json(report_file, report, 0o640)
    # The deployment explicitly gives the report the worker's group, not the credentials or state.
    if config.get('reportGroupId') is not None:
        os.chown(report_file, -1, int(config['reportGroupId']))
    print(json.dumps({'available': report['available'], 'alertCount': len(report.get('alerts', [])), 'checkedAt': report['checkedAt']}))


if __name__ == '__main__':
    main()
