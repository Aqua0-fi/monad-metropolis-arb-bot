#!/usr/bin/env python3
"""Set only the new staging reporting/control variables. Does not touch production or deploy."""
from pathlib import Path
import json,os,stat,subprocess
os.umask(0o077)
root=Path(__file__).resolve().parent.parent
folder=Path.home()/'CodingStuff/Aqua0/secrets'
path=folder/'market-rebalancer-observer.json'
info=path.lstat()
if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o600:raise SystemExit('Unsafe local observer credential file')
values=json.loads(path.read_text())
project='1c3922b9-853b-47e0-9a4b-4586f98ef533';environment='769ac5d2-1d3c-4dcb-9a23-0d5761647daa';backend='5bd09f99-7ec9-4d42-b52c-4da6e1f2b1c8';frontend='3a425b81-1159-40f7-b214-c56a931da454'
updates={'MARKET_REBALANCER_REPORT_ORIGIN':'https://rebalancer.aqua0.xyz','MARKET_REBALANCER_REPORT_TOKEN':values['REBALANCER_REPORT_TOKEN'],'MARKET_REBALANCER_CONTROL_TOKEN':values['REBALANCER_CONTROL_TOKEN'],'MARKET_REBALANCER_NETWORK_MODE':'mainnet'}
def read(service):
 r=subprocess.run(['railway','variables','--project',project,'--environment',environment,'--service',service,'--json'],capture_output=True,text=True,timeout=30)
 if r.returncode:raise SystemExit('Staging configuration read failed. Raw output suppressed to protect credentials.')
 return json.loads(r.stdout)
before=read(backend)
backup=folder/'market-rebalancer-staging-variable-backup.json'
if not backup.exists():
 fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:json.dump({k:before.get(k) for k in updates},f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
help_result=subprocess.run(['railway','variables','set','--help'],capture_output=True,text=True,timeout=15)
if help_result.returncode or '--stdin' not in help_result.stdout:raise SystemExit('This Railway CLI lacks the required protected stdin option; no settings changed.')
for key,value in updates.items():
 if before.get(key)==value:continue
 r=subprocess.run(['railway','variables','set','--project',project,'--environment',environment,'--service',backend,'--stdin',key,'--skip-deploys'],input=value,capture_output=True,text=True,timeout=35)
 if r.returncode:
  detail=r.stderr.strip()
  for secret in values.values():
   if isinstance(secret,str) and secret:detail=detail.replace(secret,'[redacted]')
  diagnostic={'variable':key,'exit':r.returncode,'error':detail[-1800:]}
  (root/'evidence/parity/owner-staging-configuration-error.json').write_text(json.dumps(diagnostic,indent=2)+'\n')
  print(json.dumps(diagnostic,indent=2))
  raise SystemExit('Configuration failed; sanitized diagnostic saved. No credential values printed.')
after=read(backend)
if any(after.get(k)!=v for k,v in updates.items()):raise SystemExit('Staging configuration verification failed')
web=read(frontend)
report={'performedBy':'owner-run-staging-configuration','environment':'staging','origin':updates['MARKET_REBALANCER_REPORT_ORIGIN'],
 'settingsVerified':list(updates),'unrelatedVariableChanges':[k for k in before if k not in updates and before[k]!=after.get(k)],
 'deploymentsTriggered':False,'frontendBackendOrigin':web.get('BACKEND_API_ORIGIN'),
 'frontendAdminCredentialConfigured':bool(web.get('BACKEND_API_ADMIN_KEY')),
 'frontendAdminGateConfigured':bool(web.get('ADMIN_BASIC_AUTH_USER') and web.get('ADMIN_BASIC_AUTH_PASSWORD')),
 'productionChanged':False,'credentialValuesPrinted':False}
metadata_path=folder/'market-rebalancer-observer-public.json'
metadata=json.loads(metadata_path.read_text());metadata['reportOrigin']=updates['MARKET_REBALANCER_REPORT_ORIGIN'];metadata_path.write_text(json.dumps(metadata,indent=2)+'\n')
out=root/'evidence/parity/owner-staging-configuration.json';out.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2));print('Saved non-secret verification:',out)
if report['unrelatedVariableChanges']:raise SystemExit('Unrelated variables changed concurrently; inspect the result before deploying.')
