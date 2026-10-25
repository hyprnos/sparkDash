import fs from 'node:fs';

const CONFIG = new URL('../../config/network-switches.json', import.meta.url);
const finite = v => v != null && Number.isFinite(Number(v)) ? Number(v) : null;
const nonnegative = v => { const n=finite(v); return n != null && n >= 0 ? n : null; };

export function readSwitchConfig(file = CONFIG) {
  if (!fs.existsSync(file)) return null;
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (config.enabled !== true) return null;
  const url = new URL(config.prometheusUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Switch monitoring must use a local Prometheus endpoint');
  if (config.id !== 'crs812' || !Array.isArray(config.ports) || !Array.isArray(config.sensors)) throw new Error('Invalid switch inventory');
  return config;
}

export function normalizeSwitch(config, vector, now = Date.now()) {
  const rows = Array.isArray(vector) ? vector : [];
  const find = (name, predicate = () => true) => rows.find(r => r.metric?.__name__ === name && r.metric.instance === config.address && predicate(r.metric));
  const value = (name, predicate) => nonnegative(find(name,predicate)?.value?.[1]);
  const jobState = kind => {
    const job='crs812_'+kind;
    const observed = value('crs812:sample_time_seconds',m=>m.job===job);
    const ageMs = observed == null ? null : Math.max(0, now-observed*1000);
    return { observedAt:observed == null ? null : observed*1000, ageMs,
      available:value('up',m=>m.job===job)===1 && ageMs != null && ageMs <= (kind==='ports'?20000:kind==='health'?90000:180000) };
  };
  const portsState=jobState('ports'),healthState=jobState('health'),systemState=jobState('system');
  const ports=config.ports.map(p=>{
    const match=m=>m.job==='crs812_ports' && m.ifName===p.name;
    const metric=n=>portsState.available?value(n,match):null;
    const linkCode=metric('ifOperStatus');
    const speed=metric('ifHighSpeed');
    const speedBps=speed!=null&&speed>0?speed*1e6:null;
    const configuredSpeedBps=nonnegative(p.configuredSpeedBps)||null;
    const denominator=speedBps||configuredSpeedBps;
    const utilizationBasis=speedBps?'reported':configuredSpeedBps?'configured':null;
    const rx=metric('crs812:rx_bits_per_second'),tx=metric('crs812:tx_bits_per_second');
    // Full duplex has two independent directional utilisation denominators.
    // Never clamp an implausible value into a plausible-looking 100%.
    const safeRate=n=>n!=null && (denominator==null || n<=denominator*1.02)?n:null;
    const rxBps=safeRate(rx),txBps=safeRate(tx);
    return {...p,link:linkCode===1?'up':linkCode==null?'unknown':linkCode===2?'down':linkCode===6?'not-present':'other',
      speedBps,configuredSpeedBps,utilizationBasis,rxBps,txBps,rxUtilization:rxBps!=null&&denominator?rxBps/denominator:null,txUtilization:txBps!=null&&denominator?txBps/denominator:null,
      rxErrors:metric('ifInErrors'),txErrors:metric('ifOutErrors'),rxDiscards:metric('ifInDiscards'),txDiscards:metric('ifOutDiscards'),
      rxErrorsPerSecond:metric('crs812:rx_errors_per_second'),txErrorsPerSecond:metric('crs812:tx_errors_per_second')};
  });
  const sensors=config.sensors.map(s=>{
    const raw=healthState.available?finite(find('mtxrGaugeValue',m=>m.job==='crs812_health'&&m.mtxrGaugeName===s.name)?.value?.[1]):null;
    return {...s,value:raw==null?null:raw*s.scale};
  });
  const uptime=systemState.available?value('sysUpTime',m=>m.job==='crs812_system'):null;
  return {id:config.id,name:config.name,address:config.address,model:config.model,routeros:config.routeros,
    available:portsState.available,status:portsState.available?'online':portsState.observedAt==null?'unavailable':'stale',
    observedAt:portsState.observedAt,ageMs:portsState.ageMs,health:healthState,system:systemState,
    uptimeSeconds:uptime==null?null:uptime/100,sensors,ports,retentionDays:30,trafficIntervalSeconds:5,healthIntervalSeconds:30};
}

export function normalizeHistory(config,matrix,start,end,step) {
  const rows=Array.isArray(matrix)?matrix:[];
  const points=[];
  for(let t=start;t<=end;t+=step)points.push(t);
  const values=row=>new Map((row?.values||[]).map(([t,v])=>[Number(t),finite(v)]));
  const ups={ports:values(rows.find(r=>r.metric.__name__==='up'&&r.metric.job==='crs812_ports')),health:values(rows.find(r=>r.metric.__name__==='up'&&r.metric.job==='crs812_health'))};
  const sampled=Object.fromEntries(['ports','health'].map(kind=>[kind,values(rows.find(r=>r.metric.__name__==='crs812:sample_time_seconds'&&r.metric.job==='crs812_'+kind))]));
  const fresh=(kind,t)=>ups[kind].get(t)===1&&sampled[kind].get(t)!=null&&t-sampled[kind].get(t)>=0&&t-sampled[kind].get(t)<=(kind==='ports'?20:90);
  const series=[];
  for(const p of config.ports)for(const direction of ['rx','tx']){
    const data=values(rows.find(r=>r.metric.__name__===`crs812:${direction}_bits_per_second`&&r.metric.ifName===p.name));
    series.push({id:p.name+':'+direction,name:p.name,label:p.peer||p.name,kind:direction,unit:'Gbps',values:points.map(t=>[t,fresh('ports',t)&&data.get(t)!=null&&data.get(t)>=0?data.get(t)/1e9:null])});
  }
  for(const s of config.sensors.filter(s=>s.kind==='temperature')){
    const data=values(rows.find(r=>r.metric.__name__==='mtxrGaugeValue'&&r.metric.mtxrGaugeName===s.name));
    series.push({id:s.name,name:s.name,label:s.label||s.name,kind:'temperature',unit:s.unit,values:points.map(t=>[t,fresh('health',t)&&data.get(t)!=null?data.get(t)*s.scale:null])});
  }
  return {start,end,step,series};
}

export class SwitchTelemetry {
  constructor({configFile=CONFIG,fetchFn=fetch,now=Date.now}={}){this.configFile=configFile;this.fetchFn=fetchFn;this.now=now;this.cached=null;this.cachedAt=0;this.pending=null;}
  async query(config,expression,range){
    const base=new URL(config.prometheusUrl);
    const url=new URL(range?'/api/v1/query_range':'/api/v1/query',base);
    url.searchParams.set('query',expression);
    if(range)for(const [k,v]of Object.entries(range))url.searchParams.set(k,String(v));
    const r=await this.fetchFn(url,{signal:AbortSignal.timeout(range?8000:4000)});
    if(!r.ok)throw new Error('Local switch history service unavailable');
    const body=await r.json();
    if(body.status!=='success'||!Array.isArray(body.data?.result))throw new Error('Invalid switch history response');
    return body.data.result;
  }
  async snapshot(){
    const config=readSwitchConfig(this.configFile);
    if(!config)return {enabled:false,switches:[]};
    if(this.cached&&this.now()-this.cachedAt<3000)return this.cached;
    if(this.pending)return this.pending;
    this.pending=(async()=>{
      let vector=[],error=null;
      try{vector=await this.query(config,'{job=~"crs812_(ports|health|system)"}');}
      catch{error='Switch collector unavailable; live readings are unknown';}
      const device=normalizeSwitch(config,vector,this.now());
      this.cached={enabled:true,switches:[device],...(error?{error}:{})};this.cachedAt=this.now();return this.cached;
    })();
    try{return await this.pending;}finally{this.pending=null;}
  }
  async history(id,range='1h'){
    const config=readSwitchConfig(this.configFile);
    if(!config||config.id!==id)return null;
    const window={ '1h':[3600,15], '24h':[86400,300], '7d':[604800,1800]}[range];
    if(!window)throw new Error('Unsupported switch history range');
    const [duration,step]=window,end=Math.floor(this.now()/1000/step)*step,start=end-duration;
    const matrix=await this.query(config,'{__name__=~"crs812:(rx_bits_per_second|tx_bits_per_second)|mtxrGaugeValue|up|crs812:sample_time_seconds",job=~"crs812_(ports|health)"}',{start,end,step});
    return {id,range,...normalizeHistory(config,matrix,start,end,step)};
  }
}

export function registerSwitchRoutes(app,telemetry=new SwitchTelemetry()){
  app.get('/api/network-switches',async(_req,res)=>{
    try{res.json(await telemetry.snapshot());}catch{res.status(503).json({error:'Switch inventory unavailable'});}
  });
  app.get('/api/network-switches/:id/history',async(req,res)=>{
    const range=req.query.range||'1h';
    if(!['1h','24h','7d'].includes(range))return res.status(400).json({error:'Unsupported switch history range'});
    try{const data=await telemetry.history(req.params.id,range);data?res.json(data):res.status(404).json({error:'Switch not configured'});}
    catch{res.status(503).json({error:'Switch history unavailable'});}
  });
}
