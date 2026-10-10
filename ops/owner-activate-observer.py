#!/usr/bin/env python3
"""Start only the prepared observer/watchdog and add its isolated HTTPS route. No blockchain writes."""
from pathlib import Path
import json, subprocess
root = Path(__file__).resolve().parent.parent
key = str(Path.home()/'Downloads/AWS-Ubuntu-KP1.pem')
ssh = ['ssh','-i',key,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','ubuntu@18.207.103.187']
# Only our new unit definitions are copied. No credentials are copied by this helper.
r = subprocess.run(['scp','-q','-i',key,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
 str(root/'ops/aqua0-market-rebalancer-network.service'),str(root/'ops/aqua0-market-rebalancer.service'),
 'ubuntu@18.207.103.187:/home/ubuntu/.rebalancer-deploy-20260925/'], capture_output=True,text=True,timeout=30)
if r.returncode: raise SystemExit('Could not transfer the new observer unit definitions; no activation attempted.')
remote = r'''
import hashlib,json,os,shutil,socket,subprocess,time,urllib.request,urllib.error
from pathlib import Path
EXPECTED='sha256:6f822a86ead8cf622d70d3997cce32c9cd7627089d641d7e0dc706b7e2e59545'
DOMAIN='rebalancer.18-207-103-187.nip.io'
ROOT=Path('/etc/aqua0-market-rebalancer')

def run(args,timeout=20):
 r=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
 if r.returncode:raise RuntimeError('Command failed: '+' '.join(args[:3]))
 return r.stdout
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
opener=urllib.request.build_opener(NoRedirect,urllib.request.ProxyHandler({}))
def request(url,token=None):
 headers={'Accept':'application/json'}
 if token:headers['Authorization']='Bearer '+token
 try:
  with opener.open(urllib.request.Request(url,headers=headers),timeout=8) as response:
   data=response.read(4*1024*1024+1)
   if len(data)>4*1024*1024:raise RuntimeError('Report exceeds bound')
   return response.status,json.loads(data) if response.headers.get('content-type','').startswith('application/json') else None
 except urllib.error.HTTPError as error:return error.code,None

image=Path('/home/ubuntu/market-rebalancer-builds/20260925-v4-kms/image-r3.id').read_text().strip()
if image!=EXPECTED:raise RuntimeError('Unexpected observer image; refusing activation')
image_id=run(['docker','image','inspect','--format','{{.Id}}',image]).strip()
settings=json.loads((ROOT/'settings.json').read_text())
if settings['mode']!='observe' or settings.get('execution') or settings.get('markets') or settings['apiUrl']!='https://staging-api.aqua0.xyz':raise RuntimeError('Observer settings are not the reviewed discovery-only configuration')
for name in ['aqua0-market-rebalancer-network.service','aqua0-market-rebalancer.service']:
 source=Path('/home/ubuntu/.rebalancer-deploy-20260925')/name
 if 'PartOf=docker.service' not in source.read_text():raise RuntimeError('Docker restart isolation is missing')
 shutil.copyfile(source,Path('/etc/systemd/system')/name)
 os.chmod(Path('/etc/systemd/system')/name,0o644)
(ROOT/'image.env').write_text('IMAGE_ID='+image+'\n');os.chmod(ROOT/'image.env',0o600)
run(['systemctl','daemon-reload'])
run(['systemctl','reset-failed','aqua0-market-rebalancer.service'])
run(['systemctl','start','aqua0-market-rebalancer.service'])
for _ in range(30):
 try:
  container=json.loads(run(['docker','inspect','--format','{"image":{{json .Image}},"running":{{json .State.Running}},"ports":{{json .NetworkSettings.Ports}}}','aqua0-market-rebalancer']))
  ports=container['ports'].get('9091/tcp',[])
  if not container['running'] or container['image']!=image_id or not any(p['HostIp']=='127.0.0.1' and p['HostPort']=='9191' for p in ports):raise RuntimeError('Container binding mismatch')
  code,health=request('http://127.0.0.1:9191/health')
  if code==200:break
 except Exception:time.sleep(1)
else:
 subprocess.run(['systemctl','stop','aqua0-market-rebalancer.service'],capture_output=True)
 raise RuntimeError('Observer did not become healthy; only its own service was stopped')
run(['iptables','-w','5','-C','DOCKER-USER','-i','br-rebalancer','-d','169.254.0.0/16','-m','comment','--comment','aqua0-rebalancer-imds','-j','REJECT'])
run(['systemctl','enable','--now','aqua0-host-watchdog.timer'])
run(['systemctl','start','aqua0-host-watchdog.service'],timeout=55)

# Add one new Caddy site, preserving all current configuration bytes and every existing site.
resolved={r[4][0] for r in socket.getaddrinfo(DOMAIN,443,socket.AF_INET,socket.SOCK_STREAM)}
if resolved!={'18.207.103.187'}:raise RuntimeError('Observer hostname does not resolve to this host')
caddy=Path('/etc/caddy/Caddyfile');old=caddy.read_bytes();oldhash=hashlib.sha256(old).hexdigest()
marker=b'# Dedicated market-rebalancer observer; existing sites above are unchanged.'
block=('\n\n'+marker.decode()+'\n'+DOMAIN+' {\n    handle /v1/* {\n        reverse_proxy 127.0.0.1:9191\n    }\n    respond 404\n}\n').encode()
changed=False
if DOMAIN.encode() not in old:
 backup=caddy.with_name('Caddyfile.before-market-rebalancer-'+str(int(time.time())))
 shutil.copy2(caddy,backup)
 temp=caddy.with_name('Caddyfile.rebalancer-candidate')
 temp.write_bytes(old+block);shutil.copystat(caddy,temp)
 try:run(['caddy','validate','--config',str(temp),'--adapter','caddyfile'],timeout=25)
 except Exception:
  temp.unlink(missing_ok=True);raise RuntimeError('Caddy validation failed; its existing configuration was not changed')
 if hashlib.sha256(caddy.read_bytes()).hexdigest()!=oldhash:raise RuntimeError('Caddy changed concurrently; refusing to overwrite')
 os.replace(temp,caddy)
 try:run(['systemctl','reload','caddy.service'],timeout=25)
 except Exception:
  if caddy.read_bytes()==old+block:
   shutil.copy2(backup,caddy);subprocess.run(['systemctl','reload','caddy.service'],capture_output=True,timeout=25)
  raise RuntimeError('New site reload failed; previous configuration restored when safe')
 changed=True
elif marker not in old:raise RuntimeError('An unrelated observer hostname configuration already exists; not repurposing it')

values=json.loads((ROOT/'observer.json').read_text())
for _ in range(30):
 try:
  code,_=request('https://'+DOMAIN+'/v1/status')
  if code==401:break
 except Exception:pass
 time.sleep(2)
else:raise RuntimeError('HTTPS unauthenticated rejection was not verified')
code,status=request('https://'+DOMAIN+'/v1/status',values['REBALANCER_REPORT_TOKEN'])
if code!=200 or status.get('mode')!='observe':raise RuntimeError('Observer status did not verify')
code,catalog=request('https://'+DOMAIN+'/v1/markets',values['REBALANCER_REPORT_TOKEN'])
if code!=200 or catalog.get('executionActivationSupported') is not False:raise RuntimeError('Catalog permissions did not verify')
if any(m.get('policy',{}).get('approved') for m in catalog['markets'] if m.get('policy')):raise RuntimeError('Unexpected approved market during initial deployment')
public_health,_=request('https://'+DOMAIN+'/health')
if public_health!=404:raise RuntimeError('Host-only health was exposed unexpectedly')
for name in ['market-rebalancer-observer.json','host-watchdog.aws.env']:
 (Path('/home/ubuntu/.rebalancer-deploy-20260925')/name).unlink(missing_ok=True)
containers=[]
for cid in run(['docker','ps','-q']).split():
 row=json.loads(run(['docker','inspect','--format','{"name":{{json .Name}},"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}}}',cid]))
 row['name']=row['name'].lstrip('/');containers.append(row)
services={}
for name in ['aqua0-api.service','aqua0-ponder.service','aqua0-uniswapx-filler.service','caddy.service']:
 services[name]=dict(l.split('=',1) for l in run(['systemctl','show',name,'-p','MainPID','-p','ActiveState','-p','ActiveEnterTimestamp']).splitlines() if '=' in l)
proof={'performedBy':'owner-run-activation','image':image,'mode':'observe','publicOrigin':'https://'+DOMAIN,
 'httpsVerified':True,'anonymousStatus':401,'privateStatus':200,'publicHealth':404,'metadataDenyRuleVerified':True,
 'caddyNewSiteAdded':changed,'existingContainers':containers,'existingServices':services,
 'catalog':catalog,'hostHealth':json.loads(Path('/var/lib/aqua0-host-watchdog/health.json').read_text()),
 'transactionsSent':0,'kmsCredentialsInstalled':False,'watchdogTimer':run(['systemctl','is-active','aqua0-host-watchdog.timer']).strip()}
print(json.dumps(proof))
'''
r = subprocess.run(ssh+['sudo -n python3 -'],input=remote,capture_output=True,text=True,timeout=360)
if r.returncode:
    diagnostic={'exit':r.returncode,'error':r.stderr[-1800:],'note':'Only the new observer/watchdog and its additive Caddy site may have changed. Inspect before retrying.'}
    (root/'evidence/parity/owner-observer-activation-error.json').write_text(json.dumps(diagnostic,indent=2)+'\n')
    print(json.dumps(diagnostic,indent=2));raise SystemExit(r.returncode)
report=json.loads(r.stdout)
before=json.loads((root/'evidence/parity/owner-host-preflight.json').read_text())
after={row['name']:row for row in report['existingContainers']}
report['unchangedPreviousContainers']=all(after.get(row['name'])==row for row in before['containers'])
report['unchangedPreviousServices']=report['existingServices']==before['services']
path=root/'evidence/parity/aws-observer-deployment.json';path.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:report[k] for k in ['image','mode','publicOrigin','httpsVerified','metadataDenyRuleVerified','transactionsSent','watchdogTimer','unchangedPreviousContainers','unchangedPreviousServices']},indent=2))
print('Discovered pools:',len(report['catalog']['markets']))
print('Saved non-secret proof:',path)
if not report['unchangedPreviousContainers'] or not report['unchangedPreviousServices']:
    raise SystemExit('A previous workload identity changed; compare the saved evidence rather than assuming this deployment caused it.')
