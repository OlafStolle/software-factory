import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quotaReset,accountUntil,coolAccount } from './accounts.ts';
const now=1800000000000;
const event=(info:object)=>JSON.stringify({type:'rate_limit_event',rate_limit_info:info})+'\n';
test('only explicit rejected provider events trigger bounded account cooldown',()=>{
 assert.equal(quotaReset('You have hit your limit',now),null);
 assert.equal(quotaReset(event({status:'allowed_warning'}),now),null);
 assert.equal(quotaReset(event({status:'rejected',isUsingOverage:true}),now),null);
 assert.equal(quotaReset(event({status:'rejected',resetsAt:(now+60000)/1000}),now),now+60000);
 assert.equal(quotaReset(event({status:'rejected'}),now),now+15*60000);
 assert.equal(quotaReset(event({status:'rejected',resetsAt:Infinity}),now),now+15*60000);
 assert.equal(quotaReset(event({status:'rejected',resetsAt:999999999999}),now),now+7*86400000);
 assert.equal(quotaReset(event({status:'rejected'})+event({status:'allowed'}),now),null);
});
test('os and VPS2 share durable cooldown while K2 stays available after coordinator restart',()=>{
 const d=mkdtempSync(join(tmpdir(),'sf-accounts-'));try{
  coolAccount(d,'main',now+60000);coolAccount(d,'main',now+1000);
  assert.equal(accountUntil(d,'main'),now+60000);assert.equal(accountUntil(d,'k2'),0);
  assert.equal(JSON.parse(readFileSync(join(d,'account-cooldowns.json'),'utf8')).main,now+60000);
  assert.ok(accountUntil(d,'main')>now);assert.ok(accountUntil(d,'main')<=now+60001);
 }finally{rmSync(d,{recursive:true,force:true});}
});


import { execFileSync } from 'node:child_process';
test('actual entrypoint preserves unpublished build commit and dirty file on same-container restart',()=>{
 const d=mkdtempSync(join(tmpdir(),'sf-resume-'));try{
  const work=join(d,'work'),repo=join(work,'repo'),home=join(d,'home'),bin=join(d,'bin');
  for(const p of [repo,home,bin])mkdirSync(p,{recursive:true});
  const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,stdio:'pipe'}).toString().trim();
  git('init','-b','main');git('config','user.name','test');git('config','user.email','test@example.org');
  writeFileSync(join(repo,'file'),'base');git('add','.');git('commit','-m','base');
  execFileSync('git',['clone','--bare',repo,join(d,'origin')],{stdio:'pipe'});git('remote','add','origin',join(d,'origin'));
  git('checkout','-b','factory/1');git('push','-u','origin','factory/1');
  writeFileSync(join(repo,'file'),'unpublished');git('commit','-am','unpublished');const head=git('rev-parse','HEAD');
  writeFileSync(join(repo,'file'),'dirty');writeFileSync(join(work,'prompt.md'),'test');
  writeFileSync(join(bin,'gh'),'#!/bin/sh\ncase "$*" in *defaultBranchRef*) echo main;; *login*) echo test;; *id*) echo 1;; esac\n',{mode:0o700});
  writeFileSync(join(bin,'claude'),`#!/bin/sh\necho '{"type":"result","is_error":false}'\n`,{mode:0o700});
  const script=readFileSync(new URL('../image/entrypoint.sh',import.meta.url),'utf8').replaceAll('/work',work).replaceAll('/factory',join(d,'factory'));
  execFileSync('bash',['-c',script],{env:{...process.env,HOME:home,PATH:bin+':'+process.env.PATH,REPO:'a/b',ISSUE:'1',BRANCH:'factory/1',PHASE:'build'},stdio:'pipe'});
  assert.equal(git('rev-parse','HEAD'),head);assert.equal(readFileSync(join(repo,'file'),'utf8'),'dirty');
 }finally{rmSync(d,{recursive:true,force:true});}
});
