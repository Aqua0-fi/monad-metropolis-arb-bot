#!/usr/bin/env python3
"""Switch only the already-authorized observe-only service to the verified reactive image.

Refuses funded/execution configuration, a changed current image, or a pending transaction. It never
changes credentials, saved pair permissions, system units, network rules, or unrelated services.
"""
from pathlib import Path
import subprocess

REMOTE = r'''
from pathlib import Path
import hashlib,json,os,shutil,subprocess,time,urllib.request
ROOT=Path('/etc/aqua0-market-rebalancer')
DATA=Path('/var/lib/aqua0-market-rebalancer')
BUILD=Path('/home/ubuntu/market-rebalancer-builds/20260926-reactive-9e7970a')
OLD='sha256:6f822a86ead8cf622d70d3997cce32c9cd7627089d641d7e0dc706b7e2e59545'
NEW='sha256:fd3905313444dadae8228523e9b45db2a3e8f47b6b40d3c7b1e48cee48f53d26'
UNIT='aqua0-market-rebalancer.service'
def run(args,timeout=25):
 p=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
 if p.returncode:raise RuntimeError('Command failed: '+' '.join(args[:3]))
 return p.stdout.strip()
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
opener=urllib.request.build_opener(NoRedirect,urllib.request.ProxyHandler({}))
secret=json.loads((ROOT/'observer.json').read_text())
token=secret['REBALANCER_REPORT_TOKEN']
def get(path):
 request=urllib.request.Request('http://127.0.0.1:9191'+path,headers={'Authorization':'Bearer '+token,'Accept':'application/json'})
 with opener.open(request,timeout=5) as response:
  body=response.read(4*1024*1024+1)
  if len(body)>4*1024*1024:raise RuntimeError('Oversized local report')
  return json.loads(body)
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def policies(report):
 return sorted((m['chainId'],m['pool']['poolId'],json.dumps(m['policy'],sort_keys=True)) for m in report['markets'] if m.get('policy'))
def pending(value):
 if isinstance(value,dict):return bool(value.get('pending')) or any(pending(v) for v in value.values())
 if isinstance(value,list):return any(pending(v) for v in value)
 return False
settings_path=ROOT/'settings.json';secret_path=ROOT/'observer.json';pin=ROOT/'image.env'
settings=json.loads(settings_path.read_text())
if settings.get('mode')!='observe' or settings.get('execution') or settings.get('apiUrl')!='https://staging-api.aqua0.xyz':
 raise RuntimeError('Refusing any configuration other than the existing un-funded staging observer')
if (BUILD/'image.id').read_text().strip()!=NEW:raise RuntimeError('Build image does not match verified release')
if run(['docker','image','inspect','--format','{{.Id}}',NEW])!=NEW:raise RuntimeError('Verified image missing')
if run(['systemctl','is-active',UNIT])!='active':raise RuntimeError('Existing observer is not active')
if run(['docker','inspect','--format','{{.Image}}','aqua0-market-rebalancer'])!=OLD:raise RuntimeError('Another image was activated; refusing concurrent overwrite')
old_pin=pin.read_bytes()
if old_pin.decode().strip()!='IMAGE_ID='+OLD:raise RuntimeError('Unexpected old image pin')
settings_hash=digest(settings_path);secret_hash=digest(secret_path)
old_status=get('/v1/status');old_catalog=get('/v1/markets');old_history=get('/v1/executions?network=mainnet&limit=1')
if old_status['mode']!='observe' or any(c['executionEnabled'] for c in old_status['chains']):raise RuntimeError('Existing service is not watch-only')
journal=DATA/'journal.json'
if journal.exists() and pending(json.loads(journal.read_text())):raise RuntimeError('A pending transaction needs reconciliation before this rollout')
backup=Path('/var/lib/aqua0-market-rebalancer-backups')/('reactive-9e7970a-'+str(int(time.time())))
backup.mkdir(parents=True,mode=0o700)
(backup/'image.env').write_bytes(old_pin);os.chmod(backup/'image.env',0o600)
stopped=False
try:
 run(['systemctl','stop',UNIT],timeout=70);stopped=True
 if settings_hash!=digest(settings_path) or secret_hash!=digest(secret_path) or pin.read_bytes()!=old_pin:raise RuntimeError('Configuration changed during preflight')
 if journal.exists() and pending(json.loads(journal.read_text())):raise RuntimeError('Pending transaction appeared; refusing image switch')
 if any(p.is_symlink() for p in DATA.rglob('*')):raise RuntimeError('Unexpected symlink in runtime data')
 shutil.copytree(DATA,backup/'runtime',copy_function=shutil.copy2)
 temp=ROOT/'image.env.reactive-candidate';temp.write_text('IMAGE_ID='+NEW+'\n');os.chmod(temp,0o600);os.replace(temp,pin)
 run(['systemctl','start',UNIT],timeout=55)
 deadline=time.monotonic()+60
 while time.monotonic()<deadline:
  try:
   status=get('/v1/status')
   if status.get('scheduling',{}).get('mode')=='block-driven':break
  except Exception:pass
  time.sleep(1)
 else:raise RuntimeError('Reactive status did not become available')
 if run(['docker','inspect','--format','{{.Image}}','aqua0-market-rebalancer'])!=NEW:raise RuntimeError('Wrong image is running')
 if status['mode']!='observe' or any(c['executionEnabled'] for c in status['chains']) or status['metrics']['submitted']!=0:raise RuntimeError('Watch-only invariant changed')
 if not status.get('runtimeControlAvailable') or not isinstance(status.get('operatingControl'),dict):raise RuntimeError('Runtime control connection unavailable')
 new_catalog=get('/v1/markets');new_history=get('/v1/executions?network=mainnet&limit=1')
 if policies(old_catalog)!=policies(new_catalog):raise RuntimeError('Existing pair permissions changed')
 if new_history['matchedCount']!=old_history['matchedCount']:raise RuntimeError('Stored execution history changed')
 if digest(settings_path)!=settings_hash or digest(secret_path)!=secret_hash:raise RuntimeError('Configuration or credentials changed')
 result={'checkedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'oldImage':OLD,'image':NEW,'sourceCommit':'9e7970a641596d6b3dba0a4b0f711194e4af3c80',
  'mode':status['mode'],'scheduler':status['scheduling']['mode'],'registeredChains':len(status['chains']),
  'settingsUnchanged':True,'credentialsUnchanged':True,'pairPermissionsUnchanged':True,'storedExecutions':new_history['matchedCount'],
  'runtimeControlsAvailable':True,'fundsTransferred':False,'tradingEnabled':False,'backupPath':str(backup)}
 (BUILD/'rollout-result.json').write_text(json.dumps(result,indent=2));os.chmod(BUILD/'rollout-result.json',0o600)
 print(json.dumps(result,indent=2))
except Exception as error:
 if stopped and pin.read_bytes() in (old_pin,('IMAGE_ID='+NEW+'\n').encode()):
  subprocess.run(['systemctl','stop',UNIT],capture_output=True,timeout=70)
  pin.write_bytes(old_pin);os.chmod(pin,0o600)
  subprocess.run(['systemctl','start',UNIT],capture_output=True,timeout=55)
  print(json.dumps({'rolledBackTo':OLD,'errorType':type(error).__name__,'message':str(error),'runtimeDataPreserved':True}))
 raise
'''

root=Path(__file__).resolve().parent.parent
result=subprocess.run(['ssh','-i',str(Path.home()/'Downloads/AWS-Ubuntu-KP1.pem'),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',
 'ubuntu@18.207.103.187','sudo -n python3 -'],input=REMOTE,text=True,capture_output=True,timeout=240)
log=Path.home()/'.needle_mac_mcp/backups/reactive-loop-20260926/observer-rollout.log'
log.write_text(result.stdout+result.stderr);log.chmod(0o600)
print(result.stdout)
if result.returncode:print('Rollout did not complete. Non-secret details are saved in the private local log.')
raise SystemExit(result.returncode)
