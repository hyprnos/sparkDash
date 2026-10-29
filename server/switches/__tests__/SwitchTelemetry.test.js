import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {normalizeSwitch,normalizeHistory,SwitchTelemetry,readSwitchConfig} from '../SwitchTelemetry.js';
// Synthetic inventory: tests never read the live operator configuration.
const config={enabled:true,id:'crs812',name:'Test switch',address:'192.0.2.20',prometheusUrl:'http://127.0.0.1:9096',
 ports:[{name:'test-port',peer:'test-node',configuredSpeedBps:200e9}],
 sensors:[{name:'switch-temperature',kind:'temperature',scale:1,unit:'°C'},
 {name:'psu1-input-voltage',kind:'voltage',scale:.1,unit:'V'},
 {name:'psu1-power',kind:'power',scale:.1,unit:'W'}]};
const now=200000;
const row=(name,value,labels={})=>({metric:{__name__:name,instance:config.address,...labels},value:[200,String(value)]});
const job=(name,value,kind,labels={})=>row(name,value,{job:'crs812_'+kind,...labels});
const states=()=>['ports','health','system'].flatMap(k=>[job('up',1,k),job('crs812:sample_time_seconds',195,k)]);
const port=(name,value)=>job(name,value,'ports',{ifName:config.ports[0].name});
const sensor=(name,value)=>job('mtxrGaugeValue',value,'health',{mtxrGaugeName:name});
test('actual rates use independent directions; configured speed is explicitly distinguished from SNMP',()=>{
 const d=normalizeSwitch(config,[...states(),port('ifHighSpeed',0),port('ifOperStatus',1),port('crs812:rx_bits_per_second',100e9),port('crs812:tx_bits_per_second',50e9),sensor('psu1-input-voltage',2355),sensor('psu1-power',378),job('sysUpTime',10000,'system')],now);
 assert.equal(d.ports[0].speedBps,null);assert.equal(d.ports[0].utilizationBasis,'configured');
 assert.equal(d.ports[0].rxUtilization,.5);assert.equal(d.ports[0].txUtilization,.25);
 assert.equal(d.sensors.find(s=>s.name==='psu1-input-voltage').value,235.5);
 assert.equal(d.sensors.find(s=>s.name==='psu1-power').value,37.800000000000004);
 assert.equal(d.uptimeSeconds,100);assert.equal(d.sensors[0].value,null);
});
test('stale samples and absent values are unknown, never fabricated zeros',()=>{
 const d=normalizeSwitch(config,[...states(),port('ifOperStatus',1),port('crs812:rx_bits_per_second',0),sensor('switch-temperature',57)],240000);
 assert.equal(d.available,false);assert.equal(d.ports[0].rxBps,null);assert.equal(d.ports[0].rxErrors,null);
 assert.equal(d.health.available,true);assert.equal(d.sensors.find(s=>s.name==='switch-temperature').value,57);
 assert.equal(normalizeSwitch(config,[],now).sensors[0].value,null);
});
test('measured zero is retained; impossible rates are not clamped',()=>{
 const p=normalizeSwitch(config,[...states(),port('ifHighSpeed',200000),port('crs812:rx_bits_per_second',0),port('crs812:tx_bits_per_second',300e9)],now).ports[0];
 assert.equal(p.rxBps,0);assert.equal(p.txBps,null);assert.equal(p.utilizationBasis,'reported');
});
test('history keeps unknown gaps, including stale lookback samples and failed scrapes',()=>{
 const series=(name,values,labels={})=>({metric:{__name__:name,...labels},values});
 const matrix=[series('up',[[200,'1'],[215,'0'],[230,'1'],[245,'1']],{job:'crs812_ports'}),series('crs812:sample_time_seconds',[[200,'199'],[215,'214'],[230,'200'],[245,'244']],{job:'crs812_ports'}),series('crs812:rx_bits_per_second',[[200,'0'],[215,'2e9'],[230,'2e9'],[245,'1e9']],{ifName:config.ports[0].name})];
 const h=normalizeHistory(config,matrix,200,245,15);
 assert.deepEqual(h.series[0].values,[[200,0],[215,null],[230,null],[245,1]]);
 assert.ok(h.series.find(s=>s.kind==='temperature').values.every(p=>p[1]===null));
});
test('snapshot coalesces requests, bounds cache and hides downstream errors; rejects arbitrary history targets',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'switch-test-'));const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(config));
 let calls=0,clock=now,fail=false;
 const service=new SwitchTelemetry({configFile:file,now:()=>clock,fetchFn:async url=>{calls++;assert.equal(url.hostname,'127.0.0.1');if(fail)throw new Error('private credentials');return {ok:true,json:async()=>({status:'success',data:{result:states()}})};}});
 try{
  await Promise.all([service.snapshot(),service.snapshot()]);assert.equal(calls,1);await service.snapshot();assert.equal(calls,1);
  clock+=4000;fail=true;const d=await service.snapshot();assert.equal(d.switches[0].available,false);assert.doesNotMatch(JSON.stringify(d),/private credentials/);
  assert.equal(await service.history('http://external'),null);await assert.rejects(service.history('crs812','bad'));
  fs.writeFileSync(file,JSON.stringify({...config,prometheusUrl:'http://external'}));assert.throws(()=>readSwitchConfig(file),/local/);
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('peak buckets retain valid historical rates if collector is down at bucket end, and leave empty buckets unknown',()=>{
 const metric={__name__:'crs812:rx_bits_per_second',ifName:config.ports[0].name};
 const h=normalizeHistory(config,[{metric,values:[[300,'198e9'],[900,'0']]}],300,900,300,{trafficAggregation:'max'});
 assert.deepEqual(h.series[0].values,[[300,198],[600,null],[900,0]]);
 assert.ok(h.series.find(s=>s.kind==='temperature').values.every(p=>p[1]===null));
});
test('long history explicitly aggregates every traffic sample within non-overlapping buckets',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'switch-history-test-'));const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(config));
 const calls=[];
 const service=new SwitchTelemetry({configFile:file,now:()=>1805000,fetchFn:async url=>{
  const q=url.searchParams.get('query');calls.push(q);
  const metric=q.includes('max_over_time(crs812:rx_')?'crs812:rx_bits_per_second':q.includes('max_over_time(crs812:tx_')?'crs812:tx_bits_per_second':null;
  return {ok:true,json:async()=>({status:'success',data:{result:metric?[{metric:{__name__:metric,ifName:config.ports[0].name},values:[[Number(url.searchParams.get('end')),'198e9']]}]:[]}})};
 }});
 try{
  const d=await service.history('crs812','24h');
  assert.equal(d.trafficAggregation,'max');assert.equal(d.step,300);assert.equal(d.end,1805);assert.equal(d.series[0].values.at(-1)[1],198);
  assert.equal(calls.filter(q=>q.includes('max_over_time')&&q.includes('[300s]')).length,2);
  assert.ok(calls.some(q=>q.includes('mtxrGaugeValue')));
 }finally{fs.rmSync(dir,{recursive:true});}
});
