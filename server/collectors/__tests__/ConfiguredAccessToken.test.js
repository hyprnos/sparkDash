import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfiguredAccessToken } from '../../configuredAccessToken.js';
test('persistent token loads into existing auth configuration without overriding an explicit token',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dash-auth-'));const file=path.join(dir,'token');
 try{
  fs.writeFileSync(file,'fixture-secret\n',{mode:0o600});
  const env={SPARKDASH_TOKEN:''};assert.equal(loadConfiguredAccessToken(file,env),'file');assert.equal(env.SPARKDASH_TOKEN,'fixture-secret');
  assert.equal(loadConfiguredAccessToken(file,{SPARKDASH_TOKEN:'explicit'}),'environment');
  assert.equal(loadConfiguredAccessToken(file,{DASHBOARD_TOKEN:'explicit'}),'environment');
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('missing optional file preserves default behavior; empty or unreadable credential fails closed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dash-auth-'));const file=path.join(dir,'token');
 try{
  assert.equal(loadConfiguredAccessToken(file,{}),'none');
  fs.writeFileSync(file,' \n');assert.throws(()=>loadConfiguredAccessToken(file,{}),/empty/);
  assert.throws(()=>loadConfiguredAccessToken(dir,{}));
 }finally{fs.rmSync(dir,{recursive:true});}
});
