import { useEffect, useState } from 'react';
import { fetchNetworkSwitches, fetchSwitchHistory } from '../../api/networkSwitchClient';
import type { NetworkSwitch, NetworkSwitchesResponse, SwitchHistory, SwitchHistoryRange, SwitchSensor } from '../../api/networkSwitchTypes';
import { Panel } from '../ui/Panel';
import { NetworkIcon } from '../ui/icons';
import { LineAreaChart, type LinePoint } from '../ui/LineAreaChart';
import '../../styles/networkSwitch.css';

export function formatSwitchRate(value:number|null):string {
 if(value==null)return '—';
 if(value>=1e9)return `${(value/1e9).toFixed(2)} Gbps`;
 if(value>=1e6)return `${(value/1e6).toFixed(1)} Mbps`;
 if(value>=1e3)return `${(value/1e3).toFixed(1)} Kbps`;
 return `${Math.round(value)} bps`;
}
const percent=(v:number|null)=>v==null?'—':`${(v*100).toFixed(1)}%`;
const count=(v:number|null)=>v==null?'—':v.toLocaleString();
const uptime=(v:number|null)=>v==null?'Unknown':v>=86400?`${Math.floor(v/86400)}d ${Math.floor(v%86400/3600)}h`:`${Math.floor(v/3600)}h ${Math.floor(v%3600/60)}m`;
const age=(v:number|null)=>v==null?'No sample':`${Math.floor(v/1000)}s ago`;
function reading(s:SwitchSensor|undefined,known:boolean){
 if(!known||!s||s.value==null)return '—';
 if(s.kind==='status')return s.valueLabels?.[String(s.value)]??`Code ${s.value}`;
 return `${s.value.toLocaleString(undefined,{maximumFractionDigits:s.kind==='fan'?0:1})}${s.unit==='°C'?'':' '}${s.unit}`;
}

function SwitchCard({device,transportStale}:{device:NetworkSwitch;transportStale:boolean}){
 const [expanded,setExpanded]=useState(false);
 const [range,setRange]=useState<SwitchHistoryRange>('1h');
 const [port,setPort]=useState(device.ports.find(p=>p.peer==='spark001')?.name??device.ports[0]?.name??'');
 const [sensor,setSensor]=useState(device.sensors.find(s=>s.name==='switch-temperature')?.name??'');
 const [history,setHistory]=useState<SwitchHistory|null>(null);
 const [historyFailed,setHistoryFailed]=useState(false);
 const known=device.available&&!transportStale,healthKnown=device.health.available&&!transportStale;
 useEffect(()=>{
  if(!expanded)return;
  let alive=true,loading=false;
  const load=async()=>{if(loading)return;loading=true;try{const d=await fetchSwitchHistory(device.id,range);if(alive){setHistory(d);setHistoryFailed(false);}}catch{if(alive)setHistoryFailed(true);}finally{loading=false;}};
  setHistory(null);void load();const timer=window.setInterval(()=>void load(),30000);
  return()=>{alive=false;window.clearInterval(timer);};
 },[expanded,range,device.id]);
 const chart=(id:string):LinePoint[]=>{
  const series=history?.series.find(s=>s.id===id);
  return (series?.values??[]).map(([t,value])=>({key:String(t),label:new Date(t*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),title:new Date(t*1000).toLocaleString()+(history?.trafficAggregation==='max'&&id.includes(':')?` · peak in previous ${history.step}s`:''),value}));
 };
 const primary=['switch-temperature','cpu-temperature','phy-temperature','fan1-speed','fan2-speed','fan3-speed','fan4-speed'];
 const issues=device.ports.filter(p=>p.link==='up'&&((p.rxErrorsPerSecond??0)>0||(p.txErrorsPerSecond??0)>0));
 return <Panel className="switch-monitor" title={`${device.name} · Network fabric`} icon={<NetworkIcon className="h-4 w-4"/>} actions={<><span className={`sw-status ${known?'is-online':'is-unknown'}`}><i/>{known?'Online':transportStale?'Stale':device.status==='stale'?'Stale':'Unavailable'}</span><button className="btn btn--sm btn--ghost" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>{expanded?'Hide details':'History & details'}</button></>}>
  <div className="sw-meta"><span>{device.model} · RouterOS {device.routeros}</span><span>{device.address} · Uptime {uptime(transportStale?null:device.uptimeSeconds)}</span></div>
  <div className="sw-sensors">{primary.map(name=>{const s=device.sensors.find(x=>x.name===name);return s?<div className="sw-sensor" key={name}><span>{s.label}</span><strong>{reading(s,healthKnown)}</strong></div>:null;})}</div>
  {!healthKnown&&<p className="sw-note">Sensor readings unavailable; last health sample {age(device.health.ageMs)}.</p>}
  {!known&&<p className="sw-note">Live port readings are unknown. Cached values are not shown as current traffic.</p>}
  {known&&issues.length>0&&<p className="sw-note sw-warning">New port errors observed on {issues.map(p=>p.peer||p.name).join(', ')}.</p>}
  <div className="sw-table-wrap"><table className="sw-ports"><caption className="sr-only">CRS812 fabric ports; RX and TX are from the switch perspective</caption><thead><tr><th>Connection</th><th>Link</th><th>RX · into switch</th><th>TX · out of switch</th>{expanded&&<><th>Errors RX / TX</th><th>Discards RX / TX</th></>}</tr></thead><tbody>{device.ports.map(p=><tr key={p.name}><td><strong>{p.peer||'Unassigned'}</strong><span>{p.name}</span></td><td><b className={known&&p.link==='up'?'sw-up':'sw-muted'}>{known?p.link==='up'?'Up':p.link==='down'?'Down':p.link:'Unknown'}</b><span>{known&&p.speedBps?`${p.speedBps/1e9} Gb/s`:known&&p.configuredSpeedBps?`${p.configuredSpeedBps/1e9} Gb/s configured`:'—'}</span></td><td><strong>{formatSwitchRate(known?p.rxBps:null)}</strong><span>{percent(known?p.rxUtilization:null)} RX</span></td><td><strong>{formatSwitchRate(known?p.txBps:null)}</strong><span>{percent(known?p.txUtilization:null)} TX</span></td>{expanded&&<><td>{count(known?p.rxErrors:null)} / {count(known?p.txErrors:null)}</td><td>{count(known?p.rxDiscards:null)} / {count(known?p.txDiscards:null)}</td></>}</tr>)}</tbody></table></div>
  <div className="sw-foot"><span>SNMPv3 · ports every {device.trafficIntervalSeconds}s · sensors every {device.healthIntervalSeconds}s</span><span>Ports {age(device.ageMs)} · Health {age(device.health.ageMs)}</span></div>
  {expanded&&<div className="sw-details">
   <div className="sw-detail-head"><h4>History</h4><div className="sw-ranges">{(['1h','24h','7d'] as const).map(r=><button key={r} className={`btn btn--sm ${range===r?'sw-selected':'btn--ghost'}`} aria-pressed={range===r} onClick={()=>setRange(r)}>{r==='1h'?'Last hour':r==='24h'?'24 hours':'7 days'}</button>)}</div></div>
   <p className="sw-note">{device.retentionDays}-day retention. Collection starts when monitoring is enabled; earlier history is not reconstructed. RX and TX have independent full-duplex utilisation. Where SNMP does not report speed, utilisation uses the labelled configured bandwidth.</p>
   {historyFailed?<p className="sw-note">History unavailable. Retry automatically in 30 seconds.</p>:history==null?<p className="sw-note">Loading switch history…</p>:<>
   <p className="sw-note">Traffic: highest {history.trafficSampleSeconds??5}s sampled rate per {history.step<60?`${history.step}s`:history.step<3600?`${history.step/60}min`:`${history.step/3600}h`} bucket. Short bursts are preserved; this is not the bucket average. Temperatures are point samples.</p>
   <label className="sw-select-label">Port<select value={port} onChange={e=>setPort(e.target.value)}>{device.ports.map(p=><option key={p.name} value={p.name}>{p.peer||p.name} · {p.name}</option>)}</select></label>
   <div className="sw-charts"><div><h5>RX · into switch · peak</h5><LineAreaChart points={chart(port+':rx')} format={v=>v.toFixed(v<1?3:1)} unit="Gbps" ariaLabel="Switch receive traffic history"/></div><div><h5>TX · out of switch · peak</h5><LineAreaChart points={chart(port+':tx')} color="var(--color-info)" format={v=>v.toFixed(v<1?3:1)} unit="Gbps" ariaLabel="Switch transmit traffic history"/></div></div>
   <label className="sw-select-label">Temperature sensor<select value={sensor} onChange={e=>setSensor(e.target.value)}>{device.sensors.filter(s=>s.kind==='temperature').map(s=><option key={s.name} value={s.name}>{s.label}</option>)}</select></label>
   <LineAreaChart points={chart(sensor)} color="var(--color-warning)" format={v=>v.toFixed(0)} unit="°C" ariaLabel="Switch temperature history"/>
   </>}
   <h4>All health sensors</h4><div className="sw-all-sensors">{device.sensors.map(s=><div key={s.name}><span>{s.label}</span><strong>{reading(s,healthKnown)}</strong></div>)}</div>
  </div>}
 </Panel>;
}

export function SwitchMonitorPanel(){
 const [data,setData]=useState<NetworkSwitchesResponse|null>(null);
 const [failed,setFailed]=useState(false);
 useEffect(()=>{
  let alive=true,loading=false,disabled=false;let expire:number|undefined;
  const load=async()=>{if(loading||disabled)return;loading=true;try{const next=await fetchNetworkSwitches();if(!alive)return;setData(next);setFailed(false);disabled=!next.enabled;window.clearTimeout(expire);expire=window.setTimeout(()=>{if(alive)setFailed(true);},20000);}catch{if(alive)setFailed(true);}finally{loading=false;}};
  void load();const timer=window.setInterval(()=>void load(),5000);
  return()=>{alive=false;window.clearInterval(timer);window.clearTimeout(expire);};
 },[]);
 if(data?.enabled===false)return null;
 if(!data)return failed?<Panel title="Network fabric" icon={<NetworkIcon className="h-4 w-4"/>}><p className="sw-note">Switch monitoring is unavailable.</p></Panel>:null;
 return <>{data.switches.map(device=><SwitchCard key={device.id} device={device} transportStale={failed}/>)}</>;
}
