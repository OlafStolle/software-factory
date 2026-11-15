import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

export type Worker = { id: string; account?: string; host: string; hostSlots: number; cpus: number; dockerHost?: string; ssh?: string; identityFile?: string; root: string; authFile?: string; slots: number; minFreeMemoryMiB: number; minFreeDiskMiB: number; enabled?: boolean };
export type Claim = { worker: Worker; name: string; repo: string; issue: number; phase: string; mode: string; startedAt: string; owner: string; image: string };
export type Execute = (cmd: string[], opts?: { input?: string; timeoutMs?: number }) => Promise<string>;

export function validateWorkers(workers: Worker[]) {
  const ids = new Set<string>();
  for (const w of workers) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(w.id) || ids.has(w.id)) throw new Error("Invalid/duplicate worker id");
    ids.add(w.id);
    if (w.account && !/^[a-z][a-z0-9-]{0,31}$/.test(w.account)) throw new Error("Invalid account id");
    if (workers.some(other => other.host === w.host && other.hostSlots !== w.hostSlots)) throw new Error("Inconsistent host slot limit");
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(w.root) || w.root.includes("..") || w.root === "/") throw new Error("Invalid worker root");
    if (w.ssh && !/^[a-zA-Z0-9_.@-]+$/.test(w.ssh)) throw new Error("Invalid SSH destination");
    if (w.dockerHost && (!/^unix:\/\/\/[a-zA-Z0-9_./-]+$/.test(w.dockerHost) || w.dockerHost.includes(".."))) throw new Error("Worker Docker endpoint must be a local Unix socket");
    if (w.identityFile && !/^\/[a-zA-Z0-9_./-]+$/.test(w.identityFile)) throw new Error("Invalid SSH identity path");
    if (w.ssh && (!w.authFile || !/^\/[a-zA-Z0-9_./-]+$/.test(w.authFile))) throw new Error("Remote authFile required");
    if (!/^[a-zA-Z0-9-]+$/.test(w.host)) throw new Error("Invalid physical host id");
    if (![w.cpus, w.hostSlots, w.slots, w.minFreeMemoryMiB, w.minFreeDiskMiB].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("Positive worker limits required");
  }
}
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export function sshCommand(w: Worker): string[] {
  if (!w.ssh) throw new Error("SSH worker required");
  return ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2", ...(w.identityFile ? ["-i", w.identityFile, "-o", "IdentitiesOnly=yes"] : []), w.ssh, "python3 -c " + quote(HOST)];
}
export function claimPath(dataDir: string, repo: string, issue: number) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isSafeInteger(issue) || issue < 1) throw new Error("Invalid job identity");
  return join(dataDir, "worker-claims", `${repo.replace("/", "__")}__${issue}.json`);
}
export function saveClaim(dataDir: string, c: Claim) {
  mkdirSync(join(dataDir, "worker-claims"), { recursive: true, mode: 0o700 });
  writeFileSync(claimPath(dataDir, c.repo, c.issue), JSON.stringify(c), { flag: "wx", mode: 0o600 });
}
export function claims(dataDir: string): Claim[] {
  let names: string[];
  try { names = readdirSync(join(dataDir, "worker-claims")); } catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
  return names.filter(n => n.endsWith(".json")).map(n => {
    const c = JSON.parse(readFileSync(join(dataDir, "worker-claims", n), "utf8"));
    validateWorkers([c.worker]);
    if (claimPath(dataDir, c.repo, c.issue) !== join(dataDir, "worker-claims", n) || !/^sf-[a-zA-Z0-9_-]+$/.test(c.name)) throw new Error("Invalid persisted claim");
    return c;
  });
}
export function releaseClaim(dataDir: string, c: Claim) { unlinkSync(claimPath(dataDir, c.repo, c.issue)); }
export async function remote(exec: Execute, w: Worker, action: string, payload: object = {}) {
  // Never include stdin or command output in an error: it may contain credentials or agent data.
  try { return JSON.parse(await exec(sshCommand(w), { input: JSON.stringify({ ...payload, action, root: w.root, authFile: w.authFile, dockerHost: w.dockerHost }), timeoutMs: 120_000 })); }
  catch { throw new Error(`Worker ${w.id}: ${action} unavailable; claim retained`); }
}
export function hasCapacity(w: Worker, capacity: { memoryMiB: number; diskMiB: number; dockerDiskMiB?: number }, occupied: number) {
  return w.enabled !== false && occupied < w.slots && capacity.memoryMiB >= w.minFreeMemoryMiB && Math.min(capacity.diskMiB, capacity.dockerDiskMiB ?? capacity.diskMiB) >= w.minFreeDiskMiB;
}

/** Stream a missing image without buffering gigabytes in the runner. */
export async function transferImage(w: Worker, imageId: string) {
  const ssh = sshCommand(w); ssh[ssh.length - 1] = (w.dockerHost ? `env DOCKER_HOST=${quote(w.dockerHost)} ` : "") + "bash -o pipefail -c " + quote("gzip -dc | docker image load --quiet");
  const source = spawn("docker", ["image", "save", imageId], { stdio: ["ignore", "pipe", "ignore"] });
  const gzip = spawn("gzip", ["-1c"], { stdio: ["pipe", "pipe", "ignore"] });
  const target = spawn(ssh[0], ssh.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
  let loaded = ""; target.stdout!.on("data", chunk => { loaded = (loaded + chunk.toString()).slice(-32768); });
  const children = [source, gzip, target];
  const done = (child: typeof source) => new Promise<void>((resolve, reject) => {
    child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error("Image transfer failed")));
  });
  const stop = () => children.forEach(child => child.kill("SIGKILL"));
  const timer = setTimeout(stop, 90 * 60_000);
  try { await Promise.all([...children.map(done), pipeline(source.stdout!, gzip.stdin!), pipeline(gzip.stdout!, target.stdin!)]); }
  catch { stop(); throw new Error(`Worker ${w.id}: image transfer failed`); }
  finally { clearTimeout(timer); }
  const ids = [...new Set([...loaded.matchAll(/Loaded image ID: (sha256:[a-f0-9]{64})/g)].map(m => m[1]))];
  if (ids.length !== 1) throw new Error(`Worker ${w.id}: ambiguous loaded image identity`);
  return ids[0];
}
const imageDigests = new Map<string, string>();
export function configDigest(manifest: string): string {
  const entries = JSON.parse(manifest);
  if (!Array.isArray(entries) || entries.length !== 1) throw new Error("Single-platform image export required");
  const digest = /^(?:blobs\/sha256\/)?([a-f0-9]{64})(?:\.json)?$/.exec(entries[0].Config)?.[1];
  if (!digest) throw new Error("Invalid exported image config digest");
  return `sha256:${digest}`;
}
export async function portableImageId(exec: Execute, sourceId: string): Promise<string> {
  if (!/^sha256:[a-f0-9]{64}$/.test(sourceId)) throw new Error("Invalid immutable image ID");
  if (!imageDigests.has(sourceId)) {
    const manifest = await exec(["timeout", "--kill-after=5s", "120s", "bash", "-o", "pipefail", "-c", `docker image save ${sourceId} | tar -xOf - manifest.json`], { timeoutMs: 130_000 });
    imageDigests.set(sourceId, configDigest(manifest));
  }
  return imageDigests.get(sourceId)!;
}
export async function ensureImage(exec: Execute, w: Worker, image: string, sourceId: string, transfer = transferImage) {
  const imageId = await portableImageId(exec, sourceId);
  if ((await remote(exec, w, "image", { image })).id === imageId) return imageId;
  const capacity = await remote(exec, w, "capacity");
  if (Math.min(capacity.diskMiB, capacity.dockerDiskMiB) < w.minFreeDiskMiB || !Number.isFinite(capacity.dockerDiskMiB)) throw new Error(`Worker ${w.id}: insufficient image disk reserve`);
  const loadedId = await transfer(w, sourceId);
  await remote(exec, w, "tag", { image, imageId, loadedId });
  if ((await remote(exec, w, "image", { image })).id !== imageId) throw new Error(`Worker ${w.id}: image identity mismatch`);
  return imageId;
}

// A small SSH request handler, not a resident service. Credentials are loaded only on the worker.
const HOST = String.raw`
import json, os, pathlib, stat, subprocess, sys, shutil, tarfile, re, threading
p=json.load(sys.stdin)
if p.get('dockerHost'):
    endpoint=p['dockerHost']
    if not endpoint.startswith('unix:///'): raise RuntimeError('local Docker socket required')
    socket=pathlib.Path(endpoint[7:]); metadata=socket.lstat()
    if not stat.S_ISSOCK(metadata.st_mode) or metadata.st_uid!=os.getuid() or not os.access(socket,os.R_OK|os.W_OK): raise RuntimeError('Docker socket must be owned and accessible')
    os.environ['DOCKER_HOST']=endpoint
root=pathlib.Path(p['root'])
if not root.is_dir() or root.is_symlink() or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o022:
    raise RuntimeError('worker root must be private and owned by SSH user')
def docker(args):
    return subprocess.check_output(['docker']+args, stderr=subprocess.DEVNULL, timeout=90).decode()
def raw_image_id(image):
    return docker(['image','inspect',image,'--format','{{.Id}}']).strip()
def image_id(image):
    raw=raw_image_id(image)
    try: descriptor=json.loads(docker(['image','inspect',image,'--format','{{json .Descriptor}}']))
    except subprocess.CalledProcessError: descriptor=None
    if not descriptor: return raw
    cache=root/'image-config-digests.json'
    values=json.loads(regular(cache,200000)) if cache.exists() else {}
    if raw in values: return values[raw]
    proc=subprocess.Popen(['docker','image','save',raw],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    result=None
    timer=threading.Timer(90, proc.kill); timer.start()
    try:
        with tarfile.open(fileobj=proc.stdout,mode='r|') as archive:
            for member in archive:
                if member.name=='manifest.json':
                    if member.size>1000000: raise RuntimeError('oversized image manifest')
                    entries=json.load(archive.extractfile(member))
                    if len(entries)!=1: raise RuntimeError('single-platform export required')
                    match=re.fullmatch(r'(?:blobs/sha256/)?([a-f0-9]{64})(?:\.json)?',entries[0]['Config'])
                    if not match: raise RuntimeError('bad config digest')
                    result='sha256:'+match[1]
        if proc.wait(timeout=120)!=0 or result is None: raise RuntimeError('image export failed')
    finally:
        timer.cancel()
        if proc.poll() is None: proc.kill()
        proc.wait()
    values[raw]=result
    temporary=root/'image-config-digests.tmp'; temporary.unlink(missing_ok=True)
    safe_write(temporary,json.dumps(values)); os.replace(temporary,cache)
    return result
def regular(path, limit, tail=False):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        s=os.fstat(fd)
        if not stat.S_ISREG(s.st_mode): raise RuntimeError('invalid result file')
        if s.st_size>limit:
            if not tail: raise RuntimeError('oversized result file')
            os.lseek(fd,-limit,os.SEEK_END)
        return os.read(fd,limit).decode(errors='replace')
    finally: os.close(fd)
def safe_write(path, value):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
    with os.fdopen(fd,'w') as f: f.write(value)
if p['action']=='capacity':
    mem={line.split(':')[0]:int(line.split()[1]) for line in pathlib.Path('/proc/meminfo').read_text().splitlines()}
    docker_root=docker(['info','--format','{{.DockerRootDir}}']).strip()
    print(json.dumps({'memoryMiB':mem['MemAvailable']//1024,'diskMiB':shutil.disk_usage(root).free//1048576,'dockerDiskMiB':shutil.disk_usage(docker_root).free//1048576}))
    sys.exit()
if p['action']=='tag':
    if image_id(p.get('loadedId',p['imageId']))!=p['imageId']: raise RuntimeError('image mismatch')
    manifest=root/'owned-images.json'
    tracked=json.loads(regular(manifest,200000)) if manifest.exists() else {'current':{},'retired':[]}
    old=tracked['current'].get(p['image'])
    family=lambda tag: tag.rsplit(':',1)[0] if ':' in tag.rsplit('/',1)[-1] else tag
    loaded=p.get('loadedId',p['imageId'])
    docker(['image','tag',loaded,p['image']])
    tracked['current'][p['image']]=loaded
    if old and old!=loaded: tracked['retired'].append(old)
    for tag, previous in list(tracked['current'].items()):
        if tag==p['image'] or family(tag)!=family(p['image']): continue
        # Remove only a tag previously provisioned by us, still pointing to our recorded ID.
        try:
            if docker(['image','inspect',tag,'--format','{{.Id}}']).strip()==previous:
                docker(['image','rm',tag])
            else: continue
        except subprocess.CalledProcessError: continue
        del tracked['current'][tag]
        tracked['retired'].append(previous)
    retained=[]
    for image in set(tracked['retired']):
        if image in tracked['current'].values(): continue
        try:
            tags=json.loads(docker(['image','inspect',image,'--format','{{json .RepoTags}}'])) or []
            digests=json.loads(docker(['image','inspect',image,'--format','{{json .RepoDigests}}'])) or []
            if tags or digests: retained.append(image); continue
            docker(['image','rm',image])
        except subprocess.CalledProcessError: retained.append(image) # no force: existing containers protect it
    tracked['retired']=retained
    temporary=root/'owned-images.tmp'
    temporary.unlink(missing_ok=True)
    safe_write(temporary,json.dumps(tracked)); os.replace(temporary,manifest)
    print('{}'); sys.exit()
if p['action']=='image':
    present=docker(['image','ls','--quiet',p['image']]).strip()
    print(json.dumps({'id':image_id(p['image']) if present else None})); sys.exit()
name=p['name']
if not name.startswith('sf-') or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in name): raise RuntimeError('bad name')
job=root/name
marker=root/(name+'.owner')
receipt=root/(name+'.done')
def completed():
    if not receipt.exists(): return None
    value=json.loads(regular(receipt,16000000))
    if value['owner']!=p['owner']: raise RuntimeError('wrong receipt owner')
    return value
def container_exists():
    return name in docker(['ps','-a','--filter','name=^/'+name+'$','--format','{{.Names}}']).splitlines()
def save_receipt(value):
    temporary=root/(name+'.receipt-tmp')
    if temporary.exists(): temporary.unlink()
    safe_write(temporary,json.dumps(value)); os.replace(temporary,receipt)
def collect_files(state):
    files={}
    for n,limit in [('status.json',200000),('verify.json',2000000),('verify.md',200000),('claude.jsonl',500000),('claude.err',200000)]:
        path=job/'work'/n
        if path.exists() or path.is_symlink(): files[n]=regular(path,limit,n in ('claude.jsonl','claude.err'))
    scenario=job/'scenarios'/'scenarios.md'
    if state['phase']=='check' and (scenario.exists() or scenario.is_symlink()): files['scenarios.md']=regular(scenario,2000000)
    return files
def owned():
    if marker.is_symlink() or regular(marker,1024) != p['owner']: raise RuntimeError('wrong owner')
def info():
    data=json.loads(docker(['inspect',name]))[0]
    if data['Config']['Labels'].get('sf.owner')!=p['owner']: raise RuntimeError('wrong container owner')
    s=data['State']; labels=data['Config']['Labels']
    return {'resumeSafe':labels.get('sf.resume-safe')=='1','imageId':data['Image'],'name':name,'running':s['Running'],'startedAt':s['StartedAt'],'finishedAt':s['FinishedAt'],'exitCode':s['ExitCode'],'repo':labels['sf.repo'],'issue':int(labels['sf.issue']),'phase':labels['sf.phase'],'mode':labels['sf.mode']}
if p['action'] in ('start','preflight'):
    if image_id(p['image']) != p['imageId']: raise RuntimeError('image mismatch')
    auth=pathlib.Path(p['authFile'])
    st=auth.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077: raise RuntimeError('auth permissions')
    env={}
    for line in regular(auth,16384).splitlines():
        if not line or line.startswith('#'): continue
        k,v=line.split('=',1)
        if k not in ('CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY'): raise RuntimeError('unexpected auth field')
        env[k]=v
    if len(env)!=1 or not next(iter(env.values())): raise RuntimeError('one auth method required')
    if p['action']=='preflight':
        print('{}'); sys.exit()
    if receipt.exists():
        previous=json.loads(regular(receipt,16000000))
        if not previous.get('cleaned') or job.exists() or container_exists(): raise RuntimeError('previous cleanup incomplete')
        receipt.unlink()
    safe_write(marker,p['owner'])
    job.mkdir(mode=0o700)
    work=job/'work'; scenarios=job/'scenarios'
    # Bind roots are writable to the image UID; their host parent stays SSH-user-only.
    work.mkdir(mode=0o777); work.chmod(0o777)
    safe_write(work/'prompt.md',p['prompt'])
    mounts=['-v',str(work)+':/work']
    if p['phase']!='build':
        scenarios.mkdir(mode=0o777); scenarios.chmod(0o777)
        if p['phase']=='accept': safe_write(scenarios/'scenarios.md',p['scenarios'])
        mounts+=['-v',str(scenarios)+':/scenarios'+(':ro' if p['phase']=='accept' else '')]
    env['GH_TOKEN']=p['githubToken']
    args=['run','-d','--name',name,'--label','software-factory=1','--label','sf.owner='+p['owner']]
    for key in ('repo','issue','phase','mode'): args+=['--label','sf.'+key+'='+str(p[key])]
    args+=p['limits']+mounts
    for key,value in p['environment'].items(): args+=['-e',key+'='+str(value)]
    for key in env: args+=['-e',key]
    subprocess.check_output(['docker']+args+[p['image']],env={**os.environ,**env},stderr=subprocess.DEVNULL,timeout=90)
    print(json.dumps(info()))
elif p['action']=='inspect':
    done=completed()
    if done: print(json.dumps(done['state']))
    else: owned(); print(json.dumps(info()))
elif p['action']=='checkpoint':
    owned(); state=info()
    if state['running'] or completed(): raise RuntimeError('checkpoint requires stopped owned job')
    script='cd /work/repo || exit 2; test -d .git || exit 2; test "$(git branch --show-current)" = "$1" || exit 2; dirty=$(git status --porcelain --untracked-files=all --ignored=matching) || exit 2; ahead=$(git log --branches --not --remotes --format=%H) || exit 2; stash=$(git for-each-ref --format="%(refname)" refs/stash) || exit 2; if test -z "$dirty" && test -z "$ahead" && test -z "$stash"; then printf clean; else printf dirty; fi'
    if not (job/'work'/'repo').exists(): print(json.dumps({'clean':True,'resumable':False}))
    else:
        try:
            result=docker(['run','--rm','--network','none','--entrypoint','sh','-v',str(job/'work')+':/work:ro',state['imageId'],'-c',script,'sh','factory/'+str(p['issue'])]).strip()
            print(json.dumps({'clean':result=='clean','resumable':state['resumeSafe'] and result in ('clean','dirty')}))
        except subprocess.CalledProcessError: print(json.dumps({'clean':False,'resumable':False}))
elif p['action']=='resume':
    owned(); state=info()
    if completed() or not state['resumeSafe']: raise RuntimeError('job image cannot safely resume')
    if not state['running']: docker(['start',name])
    print(json.dumps(info()))
elif p['action']=='stop':
    done=completed()
    if done: print(json.dumps(done['state']))
    else:
        owned(); state=info()
        if state['running']: docker(['kill',name])
        print(json.dumps(info()))
elif p['action']=='collect':
    done=completed()
    if done: print(json.dumps(done['files']))
    else:
        owned(); state=info()
        if state['running']: raise RuntimeError('still running')
        print(json.dumps(collect_files(state)))
elif p['action']=='cleanup':
    done=completed()
    if not done:
        owned(); state=info()
        if state['running']: raise RuntimeError('still running')
        done={'owner':p['owner'],'state':state,'files':collect_files(state),'cleaned':False}
        save_receipt(done)
    if container_exists() and info()['running']: raise RuntimeError('still running')
    if job.exists():
        if job.is_symlink(): raise RuntimeError('invalid job directory')
        # Only this exact owned job mount is removable, never an arbitrary host path.
        docker(['run','--rm','--network','none','--user','0','--entrypoint','sh','-v',str(job)+':/cleanup',done['state']['imageId'],'-c','find /cleanup -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'])
        job.rmdir()
    if container_exists(): docker(['rm',name])
    marker.unlink(missing_ok=True)
    done['cleaned']=True; save_receipt(done)
    print('{}')
else: raise RuntimeError('unknown action')
`;
