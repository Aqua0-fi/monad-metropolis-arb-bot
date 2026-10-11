#!/usr/bin/env python3
"""Test-only stand-in for the worker under ops/owner-timed-run-monad.py (anvil e2e and unit tests).

argv: <worker config path> <max runtime ms>. Reads the executor's paused()/activeUntil() over the
RPC in RPC_URL_MAINNET_MONAD (a 127.0.0.1 anvil) and prints one JSON line, then behaves per
FAKE_WORKER_MODE: crash (exit 7), sleep (exit 0 at the runtime limit), hang (ignore SIGTERM, spawn a
grandchild, never exit). It never signs or sends anything.
"""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request


def call(rpc, to, selector):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_call',
                       'params': [{'to': to, 'data': selector}, 'latest']}).encode()
    request = urllib.request.Request(rpc, data=body, headers={'content-type': 'application/json'})
    with urllib.request.urlopen(request, timeout=10) as response:
        return int(json.loads(response.read())['result'], 16)


def main():
    try:
        config = json.load(open(sys.argv[1]))
    except (OSError, ValueError):
        config = {}
    runtime_ms = int(sys.argv[2])
    mode = os.environ.get('FAKE_WORKER_MODE', 'sleep')
    rpc = os.environ.get('RPC_URL_MAINNET_MONAD', '')
    report = {'event': 'fake_worker_started', 'mode': config.get('mode'), 'runtimeMs': runtime_ms,
              'allowBroadcast': config.get('execution', {}).get('143', {}).get('allowBroadcast'),
              'hasReadKey': bool(os.environ.get('AQUA0_READ_API_KEY')),
              'hasOperatorKey': bool(os.environ.get('AQUA0_OPERATOR_API_KEY')),
              'hasAws': any(k.startswith('AWS_ACCESS') for k in os.environ)}
    executor = config.get('execution', {}).get('143', {}).get('executor')
    if rpc.startswith('http://127.0.0.1') and executor:
        try:
            report['paused'] = bool(call(rpc, executor, '0x5c975abb'))
            report['activeUntil'] = call(rpc, executor, '0xa6ee44e0')
        except OSError as exc:
            report['rpcError'] = type(exc).__name__
    print(json.dumps(report), flush=True)
    if mode == 'crash':
        sys.exit(7)
    if mode == 'hang':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        child = subprocess.Popen([sys.executable, '-c', 'import signal, time\n'
                                  'signal.signal(signal.SIGTERM, signal.SIG_IGN)\nwhile True: time.sleep(1)'])
        print(json.dumps({'event': 'grandchild', 'pid': child.pid}), flush=True)
        while True:
            time.sleep(1)
    time.sleep(runtime_ms / 1000)
    print(json.dumps({'event': 'backend_budget_summary', 'backendBudget': {'calls': {'search': 0}}}), flush=True)


if __name__ == '__main__':
    main()
