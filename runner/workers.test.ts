import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { claims, saveClaim, releaseClaim, remote, validateWorkers, hasCapacity, sshCommand, type Worker, type Claim } from './workers.ts';
const worker = (root: string): Worker => ({ id:'os',host:'os',hostSlots:1,cpus:2,ssh:'os@100.118.14.72',identityFile:'/etc/software-factory/worker_ed25519',root,authFile:join(root,'auth.env'),slots:1,minFreeMemoryMiB:4096,minFreeDiskMiB:20480 });

test('worker validation, shared physical-host limits and SSH restrictions', () => {
  const w=worker('/mnt/data/factory-worker'); validateWorkers([w]);
  for (const bad of [{...w,ssh:'-oProxyCommand=evil'},{...w,root:'/'},{...w,slots:0},{...w,hostSlots:0},{...w,dockerHost:'tcp://public:2375'},{...w,dockerHost:'unix:///tmp/../docker.sock'}]) assert.throws(()=>validateWorkers([bad]));
  assert.throws(()=>validateWorkers([w,{...w,id:'k2',hostSlots:2}]));
  const cmd=sshCommand(w).join(' ');
  for (const value of ['StrictHostKeyChecking=yes','BatchMode=yes','IdentitiesOnly=yes','worker_ed25519']) assert.ok(cmd.includes(value));
  assert.equal(hasCapacity(w,{memoryMiB:5000,diskMiB:30000},0),true);
  assert.equal(hasCapacity(w,{memoryMiB:5000,diskMiB:30000},1),false);
  assert.equal(hasCapacity(w,{memoryMiB:4000,diskMiB:30000},0),false);
  assert.equal(hasCapacity(w,{memoryMiB:5000,diskMiB:20000},0),false);
});

test('claims survive lost contact and refuse a second dispatch', async () => {
  const d=mkdtempSync(join(tmpdir(),'sf-claim-'));
  try {
    const c:Claim={worker:worker(d),repo:'a/b',issue:1,name:'sf-a-b-1',phase:'build',mode:'new',startedAt:new Date().toISOString(),owner:'nonce',image:'image'};
    saveClaim(d,c); assert.throws(()=>saveClaim(d,c)); assert.deepEqual(claims(d),[c]);
    await assert.rejects(remote(async()=>{throw Error('token secret');},c.worker,'inspect',c),e=>String(e).includes('claim retained')&&!String(e).includes('token secret'));
    assert.deepEqual(claims(d),[c]); releaseClaim(d,c); assert.deepEqual(claims(d),[]);
  } finally {rmSync(d,{recursive:true,force:true});}
});

// Execute the actual Python SSH handler locally with a fake Docker executable.
function hostFixture() {
  const d=mkdtempSync(join(tmpdir(),'sf-host-')); const root=join(d,'root'); mkdirSync(root,{mode:0o700});
  const w=worker(root); writeFileSync(w.authFile!,'CLAUDE_CODE_OAUTH_TOKEN=private-test-secret\n',{mode:0o600});
  const bin=join(d,'docker'); const state=join(d,'state.json');
  writeFileSync(bin,`#!/usr/bin/env python3
import sys,json,os,pathlib,shutil,tarfile,io,subprocess
a=sys.argv[1:]; state=pathlib.Path(os.environ['FAKE_STATE'])
expected=state.parent/'expected-docker-host'
if expected.exists(): assert os.environ.get('DOCKER_HOST')==expected.read_text()
if a[:2]==['image','save']:
 data=json.dumps([{'Config':'blobs/sha256/'+'a'*64}]).encode()
 with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as archive:
  info=tarfile.TarInfo('manifest.json');info.size=len(data);archive.addfile(info,io.BytesIO(data))
 with (state.parent/'exports').open('a') as f: f.write('export')
elif a[0]=='info': print(str(state.parent))
elif a[:2]==['image','inspect']:
 if a[-1]=='{{json .Descriptor}}': print('{\"mediaType\":\"application/vnd.oci.image.index.v1+json\"}' if (state.parent/'containerd').exists() else 'null')
 elif a[-1]=='{{json .RepoTags}}': print('[\"foreign:only-tag\"]' if (state.parent/'foreign-tag').exists() else '[]')
 elif a[-1]=='{{json .RepoDigests}}': print('[]')
 else: print(json.loads((state.parent/'tag-ids').read_text()).get(a[2],a[2]) if (state.parent/'tag-ids').exists() else (a[2] if a[2].startswith('sha256:') else 'sha256:expected'))
elif a[:2]==['image','tag']: pass
elif a[:2]==['image','rm']:
 assert '--force' not in a and '-f' not in a
 with (state.parent/'image-removals').open('a') as f: f.write(a[2]+'\\n')
 if (state.parent/'protected-image').exists(): sys.exit(1)
elif a[0]=='inspect': print(json.dumps([json.loads(state.read_text())]))
elif a[0]=='run' and '--name' in a:
 labels=dict(a[i+1].split('=',1) for i,v in enumerate(a) if v=='--label'); labels['sf.resume-safe']='1'
 assert 'private-test-secret' not in ' '.join(a)
 assert os.environ.get('CLAUDE_CODE_OAUTH_TOKEN')=='private-test-secret'
 state.write_text(json.dumps({'Image':'sha256:job-immutable','Config':{'Labels':labels},'State':{'Running':False,'StartedAt':'2026-11-14T00:00:00Z','FinishedAt':'2026-11-14T00:01:00Z','ExitCode':0}})); print('containerid')
elif a[0]=='start':
 data=json.loads(state.read_text());data['State']['Running']=True;state.write_text(json.dumps(data))
elif a[0]=='run' and a[a.index('-v')+1].endswith('/work:ro'):
 assert a[a.index('--network')+1]=='none' and '-e' not in a and '--env-file' not in a
 mount=a[a.index('-v')+1].split(':')[0]
 script=a[a.index('-c')+1].replace('/work',mount)
 result=subprocess.run(['sh','-c',script,'sh',a[-1]],capture_output=True,text=True)
 print(result.stdout,end='');sys.exit(result.returncode)
elif a[0]=='run':
 assert a[a.index('--network')+1]=='none' and '-e' not in a and '--env-file' not in a
 assert a[a.index('-c')-1]=='sha256:job-immutable'
 mount=a[a.index('-v')+1].split(':')[0]
 for p in pathlib.Path(mount).iterdir():
  if p.is_dir() and not p.is_symlink(): shutil.rmtree(p)
  else: p.unlink()
elif a[0]=='ps': print('sf-a-b-1' if state.exists() else '')
elif a[0]=='rm':
 state.unlink(missing_ok=True)
 failure=state.parent/'fail-rm'
 if failure.exists(): failure.unlink(); sys.exit(1)
else: sys.exit(1)
`,{mode:0o700});
  const exec=async(cmd:string[],opts:any={})=>await new Promise<string>((resolve,reject)=>{
    const child=spawn('sh',['-c',cmd.at(-1)!],{env:{...process.env,PATH:d+':'+process.env.PATH,FAKE_STATE:state},stdio:['pipe','pipe','pipe']});
    let out=''; child.stdout.on('data',b=>out+=b); child.stderr.resume(); child.on('error',reject); child.on('close',c=>c===0?resolve(out):reject(Error('host failed')));child.stdin.end(opts.input);
  });
  const payload={name:'sf-a-b-1',owner:'unique',repo:'a/b',issue:1,phase:'build',mode:'new',image:'image',imageId:'sha256:expected',prompt:'do work',githubToken:'test-gh-secret',limits:['--memory','3g'],environment:{REPO:'a/b'}};
  return {d,root,w,exec,payload};
}

test('actual host handler: build hides scenarios, collects results and removes only its job', async()=>{
  const f=hostFixture();
  try {
    await remote(f.exec,f.w,'start',f.payload);
    assert.equal(existsSync(join(f.root,f.payload.name,'scenarios')),false);
    const work=join(f.root,f.payload.name,'work'); writeFileSync(join(work,'status.json'),'{"status":"accepting"}');
    const files=await remote(f.exec,f.w,'collect',f.payload); assert.equal(files['status.json'],'{"status":"accepting"}');
    writeFileSync(join(f.root,'unrelated'),'keep');
    await remote(f.exec,f.w,'cleanup',f.payload);
    assert.equal(existsSync(join(f.root,f.payload.name)),false);assert.equal(readFileSync(join(f.root,'unrelated'),'utf8'),'keep');
  } finally {rmSync(f.d,{recursive:true,force:true});}
});

test('actual host handler rejects image drift and symlink results without cleanup',async()=>{
  const f=hostFixture();
  try {
    await assert.rejects(remote(f.exec,f.w,'start',{...f.payload,imageId:'sha256:other'}));
    assert.equal(existsSync(join(f.root,f.payload.name+'.owner')),false);
    await remote(f.exec,f.w,'start',f.payload);
    symlinkSync(f.w.authFile!,join(f.root,f.payload.name,'work','status.json'));
    await assert.rejects(remote(f.exec,f.w,'collect',f.payload));
    assert.equal(existsSync(join(f.root,f.payload.name+'.owner')),true);
    await assert.rejects(remote(f.exec,f.w,'cleanup',{...f.payload,owner:'wrong'}));
  }finally{rmSync(f.d,{recursive:true,force:true});}
});

test('actual host handler carries acceptance scenarios as a separate input',async()=>{
 const f=hostFixture();try{
   await remote(f.exec,f.w,'start',{...f.payload,phase:'accept',scenarios:'hidden test'});
   assert.equal(readFileSync(join(f.root,f.payload.name,'scenarios','scenarios.md'),'utf8'),'hidden test');
   assert.equal(existsSync(join(f.root,f.payload.name,'work','scenarios.md')),false);
 }finally{rmSync(f.d,{recursive:true,force:true});}
});

test('failed check without scenarios can finish; long logs return bounded tails', async()=>{
 const f=hostFixture();try{
   const payload={...f.payload,phase:'check'};await remote(f.exec,f.w,'start',payload);
   const work=join(f.root,payload.name,'work');writeFileSync(join(work,'status.json'),'{"status":"question"}');
   writeFileSync(join(work,'claude.jsonl'),'x'.repeat(900000)+'\n{"result":"tail"}\n');
   const files=await remote(f.exec,f.w,'collect',payload);
   assert.equal(files['scenarios.md'],undefined);assert.equal(files['claude.jsonl'].length,500000);assert.ok(files['claude.jsonl'].endsWith('{"result":"tail"}\n'));
   await remote(f.exec,f.w,'cleanup',payload);
   assert.equal(existsSync(join(f.root,payload.name)),false);
 }finally{rmSync(f.d,{recursive:true,force:true});}
});

test('cleanup resumes after Docker removes container but its response is lost', async()=>{
 const f=hostFixture();try{
   await remote(f.exec,f.w,'start',f.payload);
   writeFileSync(join(f.root,f.payload.name,'work','status.json'),'{"status":"accepting"}');
   writeFileSync(join(f.d,'fail-rm'),'once');
   await assert.rejects(remote(f.exec,f.w,'cleanup',f.payload));
   assert.equal(existsSync(join(f.d,'state.json')),false);
   const recovered=await remote(f.exec,f.w,'inspect',f.payload);assert.equal(recovered.running,false);
   const files=await remote(f.exec,f.w,'collect',f.payload);assert.equal(files['status.json'],'{"status":"accepting"}');
   await remote(f.exec,f.w,'cleanup',f.payload);await remote(f.exec,f.w,'cleanup',f.payload);
   assert.equal(existsSync(join(f.root,f.payload.name)),false);
   await remote(f.exec,f.w,'start',{...f.payload,owner:'new-owner',phase:'accept',scenarios:'next phase'});
   assert.equal((await remote(f.exec,f.w,'inspect',{...f.payload,owner:'new-owner'})).phase,'accept');
 }finally{rmSync(f.d,{recursive:true,force:true});}
});

import { ensureImage } from './workers.ts';
test('image provision skips identical content and transfers immutable ID before tagging',async()=>{
 const w=worker('/tmp/private-worker');const id='sha256:'+'a'.repeat(64);let actual:string|null=null;const actions:string[]=[];let transferCount=0;
 const exec=async(_cmd:string[],opts:any)=>{if(_cmd.includes('bash'))return JSON.stringify([{Config:'blobs/sha256/'+id.slice(7)}]);const request=JSON.parse(opts.input);actions.push(request.action);if(request.action==='tag')actual=request.imageId;return JSON.stringify({id:actual,diskMiB:30000,dockerDiskMiB:30000});};
 const transfer=async(_w:Worker,image:string)=>{assert.equal(image,id);transferCount++;return id;};
 await ensureImage(exec,w,'project:tag',id,transfer);assert.deepEqual(actions,['image','capacity','tag','image']);assert.equal(transferCount,1);
 await ensureImage(exec,w,'project:tag',id,transfer);assert.equal(transferCount,1);
 actual=null;await assert.rejects(ensureImage(exec,w,'project:tag',id,async()=>{throw Error('network lost');}));
 assert.equal(actual,null);
});

 test('separate Docker partition can veto otherwise roomy workspace',()=>{
 const w=worker('/mnt/data/factory-worker');
 assert.equal(hasCapacity(w,{memoryMiB:9000,diskMiB:260000,dockerDiskMiB:5000},0),false);
 assert.equal(hasCapacity(w,{memoryMiB:9000,diskMiB:260000,dockerDiskMiB:25000},0),true);
 });

test('image cleanup removes only previously recorded owned IDs without force',async()=>{
 const f=hostFixture();try{
   await remote(f.exec,f.w,'tag',{image:'project:tag',imageId:'sha256:first'});
   assert.equal(existsSync(join(f.d,'image-removals')),false);
   await remote(f.exec,f.w,'tag',{image:'project:tag',imageId:'sha256:second'});
   assert.ok(readFileSync(join(f.d,'image-removals'),'utf8').includes('sha256:first'));
   writeFileSync(join(f.d,'protected-image'),'container uses it');
   await remote(f.exec,f.w,'tag',{image:'project:tag',imageId:'sha256:third'});
   const manifest=JSON.parse(readFileSync(join(f.root,'owned-images.json'),'utf8'));
   assert.deepEqual(manifest.retired,['sha256:second']);
 }finally{rmSync(f.d,{recursive:true,force:true});}
});

test('image cleanup preserves an old ID with a single foreign tag',async()=>{
 const f=hostFixture();try{
   await remote(f.exec,f.w,'tag',{image:'project:tag',imageId:'sha256:first'});
   writeFileSync(join(f.d,'foreign-tag'),'foreign:only-tag');
   await remote(f.exec,f.w,'tag',{image:'project:tag',imageId:'sha256:second'});
   assert.equal(existsSync(join(f.d,'image-removals')),false);
   assert.deepEqual(JSON.parse(readFileSync(join(f.root,'owned-images.json'),'utf8')).retired,['sha256:first']);
 }finally{rmSync(f.d,{recursive:true,force:true});}
});

import { configDigest } from './workers.ts';
test('containerd index ID and classic config ID share verified portable content identity',async()=>{
 const source='sha256:'+'c'.repeat(64), config='sha256:'+'d'.repeat(64), w=worker('/tmp/private-worker');
 let actual:string|null=null;let tag:any;
 const exec=async(cmd:string[],opts:any)=>{
   if(cmd.includes('bash'))return JSON.stringify([{Config:'blobs/sha256/'+config.slice(7)}]);
   const p=JSON.parse(opts.input);
   if(p.action==='tag'){tag=p;actual=p.imageId;}
   return JSON.stringify({id:actual,diskMiB:30000,dockerDiskMiB:30000});
 };
 const id=await ensureImage(exec,w,'project:tag',source,async(_w, exported)=>{assert.equal(exported,source);return config;});
 assert.equal(id,config);assert.equal(tag.loadedId,config);assert.equal(tag.imageId,config);
 assert.equal(configDigest(JSON.stringify([{Config:config.slice(7)+'.json'}])),config);
 assert.throws(()=>configDigest(JSON.stringify([{Config:'bad'}])));
 assert.throws(()=>configDigest('[]'));
});

test('actual Python handler normalizes and caches containerd image config digest',async()=>{
 const f=hostFixture();try{
   writeFileSync(join(f.d,'containerd'),'index store');
   const index='sha256:'+'c'.repeat(64), config='sha256:'+'a'.repeat(64);
   await remote(f.exec,f.w,'tag',{image:'project:tag',imageId:config,loadedId:index});
   await remote(f.exec,f.w,'tag',{image:'project:tag',imageId:config,loadedId:index});
   assert.equal(readFileSync(join(f.d,'exports'),'utf8'),'export');
   assert.equal(JSON.parse(readFileSync(join(f.root,'image-config-digests.json'),'utf8'))[index],config);
 }finally{rmSync(f.d,{recursive:true,force:true});}
});

import { createServer } from 'node:net';
test('actual handler uses an owned Unix Docker socket and rejects non-sockets',async()=>{
 const f=hostFixture();const path=join(f.d,'docker.sock');const server=createServer();
 try{
   await new Promise<void>(resolve=>server.listen(path,resolve));
   const w={...f.w,dockerHost:'unix://'+path};writeFileSync(join(f.d,'expected-docker-host'),w.dockerHost);
   const capacity=await remote(f.exec,w,'capacity');assert.ok(capacity.diskMiB>0);
   await assert.rejects(remote(f.exec,{...w,dockerHost:'unix://'+f.w.authFile},'capacity'));
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(f.d,{recursive:true,force:true});}
});

 test('versioned image family retires only its own previous tag and preserves foreign tags',async()=>{
 const f=hostFixture();try{
   await remote(f.exec,f.w,'tag',{image:'sf-job-project:v1',imageId:'sha256:first'});
   writeFileSync(join(f.d,'tag-ids'),JSON.stringify({'sf-job-project:v1':'sha256:first'}));
   writeFileSync(join(f.d,'foreign-tag'),'foreign:only-tag');
   await remote(f.exec,f.w,'tag',{image:'sf-job-project:v2',imageId:'sha256:second'});
   assert.equal(readFileSync(join(f.d,'image-removals'),'utf8'),'sf-job-project:v1\n');
   const tracked=JSON.parse(readFileSync(join(f.root,'owned-images.json'),'utf8'));
   assert.deepEqual(tracked.current,{'sf-job-project:v2':'sha256:second'});
   assert.deepEqual(tracked.retired,['sha256:first']);
 }finally{rmSync(f.d,{recursive:true,force:true});}
 });

test('cleanup pins the inspected image ID even after its version tag is retired',async()=>{
 const f=hostFixture();try{
   await remote(f.exec,f.w,'start',f.payload);
   await remote(f.exec,f.w,'cleanup',{...f.payload,image:'retired:unavailable'});
   const receipt=JSON.parse(readFileSync(join(f.root,f.payload.name+'.done'),'utf8'));
   assert.equal(receipt.state.imageId,'sha256:job-immutable');
   assert.equal(receipt.cleaned,true);
 }finally{rmSync(f.d,{recursive:true,force:true});}
});


test('actual checkpoint distinguishes pushed, dirty and unpublished work; only owned stopped job resumes',async()=>{
 const f=hostFixture();try{
  await remote(f.exec,f.w,'start',f.payload);
  const repo=join(f.root,f.payload.name,'work','repo');mkdirSync(repo);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});
  git('init','-b','factory/1');git('config','user.name','test');git('config','user.email','test@example.org');
  writeFileSync(join(repo,'file'),'base');git('add','.');git('commit','-m','base');git('update-ref','refs/remotes/origin/main','HEAD');
  assert.deepEqual(await remote(f.exec,f.w,'checkpoint',f.payload),{clean:true,resumable:true});
  writeFileSync(join(repo,'.git','info','exclude'),'ignored\n');writeFileSync(join(repo,'ignored'),'local work');
  assert.deepEqual(await remote(f.exec,f.w,'checkpoint',f.payload),{clean:false,resumable:true});rmSync(join(repo,'ignored'));
  writeFileSync(join(repo,'file'),'dirty');writeFileSync(join(repo,'untracked'),'unpublished');git('stash','push','-u');
  assert.deepEqual(await remote(f.exec,f.w,'checkpoint',f.payload),{clean:false,resumable:true});
  git('stash','pop');
  assert.deepEqual(await remote(f.exec,f.w,'checkpoint',f.payload),{clean:false,resumable:true});
  git('add','.');git('commit','-m','unpublished');
  assert.deepEqual(await remote(f.exec,f.w,'checkpoint',f.payload),{clean:false,resumable:true});
  await assert.rejects(remote(f.exec,f.w,'resume',{...f.payload,owner:'foreign'}));
  const stateFile=join(f.d,'state.json'),old=JSON.parse(readFileSync(stateFile,'utf8'));delete old.Config.Labels['sf.resume-safe'];writeFileSync(stateFile,JSON.stringify(old));
  assert.deepEqual(await remote(f.exec,f.w,'checkpoint',f.payload),{clean:false,resumable:false});
  await assert.rejects(remote(f.exec,f.w,'resume',f.payload));
  old.Config.Labels['sf.resume-safe']='1';writeFileSync(stateFile,JSON.stringify(old));
  await remote(f.exec,f.w,'resume',f.payload);
  assert.equal((await remote(f.exec,f.w,'inspect',f.payload)).running,true);
  await assert.rejects(remote(f.exec,f.w,'checkpoint',f.payload));
 }finally{rmSync(f.d,{recursive:true,force:true});}
});
