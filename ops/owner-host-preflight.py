#!/usr/bin/env python3
"""Owner-run read-only host preflight. Writes only a local, non-secret result file."""
from pathlib import Path
import json
import subprocess

root = Path(__file__).resolve().parent.parent
remote = r'''
from pathlib import Path
import importlib.util,ipaddress,json,platform,shutil,socket,subprocess

def run(args):
 return subprocess.run(args,capture_output=True,text=True,timeout=12)
def checked(args):
 r=run(args)
 if r.returncode: raise RuntimeError(' '.join(args[:3]) + ': ' + r.stderr.strip()[:400])
 return r.stdout
networks=json.loads(checked(['docker','network','inspect',*checked(['docker','network','ls','-q']).split()]))
subnets=[c['Subnet'] for n in networks for c in ((n.get('IPAM') or {}).get('Config') or []) if c and c.get('Subnet')]
candidates=['172.30.91.0/28','172.29.91.0/28','172.28.91.0/28']
chosen=next((c for c in candidates if all(ipaddress.ip_network(c).version!=ipaddress.ip_network(s).version or not ipaddress.ip_network(c).overlaps(ipaddress.ip_network(s)) for s in subnets)),None)
containers=[]
ids=checked(['docker','ps','-q']).split()
for i in ids:
 row=json.loads(checked(['docker','inspect','--format','{"name":{{json .Name}},"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}}}',i]))
 row['name']=row['name'].lstrip('/')
 if not row['name'].startswith('buildx_buildkit_'):containers.append(row)
services={}
for service in ['aqua0-api.service','aqua0-ponder.service','aqua0-uniswapx-filler.service','caddy.service']:
 values=run(['systemctl','show',service,'-p','MainPID','-p','ActiveState','-p','ActiveEnterTimestamp']).stdout.splitlines()
 services[service]=dict(v.split('=',1) for v in values if '=' in v)
port=9191
s=socket.socket()
try:s.bind(('127.0.0.1',port));portAvailable=True
except OSError:portAvailable=False
finally:s.close()
iptables=shutil.which('iptables')
chainExists=bool(iptables and run([iptables,'-S','DOCKER-USER']).returncode==0)
report={'host':'18.207.103.187','architecture':platform.machine(),'selectedSubnet':chosen,'existingSubnets':subnets,
 'dockerUserFirewallChainExists':chainExists,'workerPort':port,'workerPortAvailable':portAvailable,
 'containers':containers,'services':services,'boto3Installed':bool(importlib.util.find_spec('boto3')),
 'diskFreeBytes':shutil.disk_usage('/').free,'sourceBuildExists':Path('/home/ubuntu/market-rebalancer-builds/20260925-v4-kms/image.id').is_file()}
print(json.dumps(report))
'''
result = subprocess.run(['ssh','-i',str(Path.home()/'Downloads/AWS-Ubuntu-KP1.pem'),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','ubuntu@18.207.103.187','sudo -n python3 -'], input=remote, capture_output=True,text=True,timeout=60)
if result.returncode:
    details = {'exit': result.returncode, 'error': result.stderr.strip()[-2000:], 'hostChanged': False}
    (root/'evidence/parity/owner-host-preflight-error.json').write_text(json.dumps(details, indent=2)+'\n')
    print(json.dumps(details, indent=2))
    raise SystemExit('Read-only host preflight failed; diagnostic saved, no host changes were made.')
report=json.loads(result.stdout)
out=root/'evidence/parity/owner-host-preflight.json'
out.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:report[k] for k in ['architecture','selectedSubnet','dockerUserFirewallChainExists','workerPortAvailable','boto3Installed','diskFreeBytes','sourceBuildExists']},indent=2))
print('Existing workloads recorded:',len(report['containers']))
print('Saved non-secret result:',out)
