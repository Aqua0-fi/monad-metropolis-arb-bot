#!/usr/bin/env python3
"""Owner-run live checks: a harmless KMS message and ordinary read-tier HTTP, never a transaction."""
from pathlib import Path
import json
import os
import shlex
import stat
import subprocess
import urllib.request
import urllib.error

root = Path(__file__).resolve().parent.parent
secrets = Path.home() / 'CodingStuff/Aqua0/secrets'

def owner_file(name):
    path = secrets / name
    info = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise SystemExit('Refusing an unsafe credential file: ' + name)
    return path

values = {}
for line in owner_file('market-rebalancer.aws.env').read_text().splitlines():
    if not line.strip() or line.lstrip().startswith('#'):
        continue
    key, value = line.split('=', 1)
    parts = shlex.split(value)
    if len(parts) != 1:
        raise SystemExit('Invalid credential-file syntax')
    values[key] = parts[0]
env = {k: v for k, v in os.environ.items() if not k.startswith('AWS_')}
env.update(values)
env.update({'AWS_CONFIG_FILE': '/dev/null', 'AWS_SHARED_CREDENTIALS_FILE': '/dev/null', 'AWS_EC2_METADATA_DISABLED': 'true'})
result = subprocess.run(['node', '--import', 'tsx', 'scripts/check-kms.ts'], cwd=root, env=env, capture_output=True, text=True, timeout=40)
report = {'performedBy': 'owner-run-command', 'transactionsSent': 0, 'signingPurpose': 'random domain-separated readiness message only'}
if result.returncode:
    report['kms'] = {'verified': False, 'error': 'KMS readiness failed. Credential-bearing output was suppressed.'}
else:
    proof = json.loads(result.stdout)
    if proof.get('purpose') != 'kms-readiness-only' or proof.get('transactionsSent') != 0 or proof.get('address', '').lower() != values['MARKET_REBALANCER_OPERATOR_ADDRESS'].lower():
        raise SystemExit('Unexpected KMS readiness result')
    (root/'evidence/parity/kms-readiness.json').write_text(json.dumps(proof, indent=2)+'\n')
    report['kms'] = {'verified': True, 'address': proof['address']}

data = json.loads(owner_file('market-rebalancer-observer.json').read_text())
headers = {'X-API-Key': data['AQUA0_READ_API_KEY'], 'X-Network-Mode': 'mainnet', 'Accept': 'application/json'}
requests = []
for path, expected in [('/api/vaults/pools?chainId=8453&includeArming=true', 200), ('/api/admin/market-rebalancer', 401)]:
    row = {'path': path, 'expectedStatus': expected}
    try:
        request = urllib.request.Request('https://staging-api.aqua0.xyz'+path, headers=headers)
        with urllib.request.urlopen(request, timeout=25) as response:
            row['status'] = response.status
            if path.startswith('/api/vaults/'):
                body = response.read(4*1024*1024+1)
                if len(body) > 4*1024*1024:
                    raise ValueError('Oversized response')
                listing = json.loads(body)
                row['poolCount'] = len(listing.get('pools', []))
                row['rpcDegraded'] = listing.get('rpcDegraded')
    except urllib.error.HTTPError as error:
        row['status'] = error.code
    except Exception as error:
        row['errorType'] = type(error).__name__
    row['expectedAccessVerified'] = row.get('status') == expected
    requests.append(row)
report['ordinaryReadAccess'] = requests
report['allChecksPassed'] = report['kms']['verified'] and all(row['expectedAccessVerified'] for row in requests)
out = root/'evidence/parity/owner-readiness-result.json'
out.write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report, indent=2))
print('Saved non-secret result:', out)
raise SystemExit(0 if report['allChecksPassed'] else 1)
