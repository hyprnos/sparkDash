export interface SwitchSensor {
  name: string;
  label: string;
  kind: 'temperature' | 'fan' | 'power' | 'voltage' | 'status';
  unit: string;
  scale: number;
  value: number | null;
  valueLabels?: Record<string,string>;
}
export interface SwitchPort {
  name: string;
  peer?: string;
  link: 'up' | 'down' | 'not-present' | 'other' | 'unknown';
  speedBps: number | null;
  configuredSpeedBps: number | null;
  utilizationBasis: 'reported' | 'configured' | null;
  rxBps: number | null;
  txBps: number | null;
  rxUtilization: number | null;
  txUtilization: number | null;
  rxErrors: number | null;
  txErrors: number | null;
  rxDiscards: number | null;
  txDiscards: number | null;
  rxErrorsPerSecond: number | null;
  txErrorsPerSecond: number | null;
}
export interface NetworkSwitch {
  id: string;
  name: string;
  address: string;
  model: string;
  routeros: string;
  available: boolean;
  status: 'online' | 'stale' | 'unavailable';
  observedAt: number | null;
  ageMs: number | null;
  health: {available:boolean;observedAt:number|null;ageMs:number|null};
  system: {available:boolean;observedAt:number|null;ageMs:number|null};
  uptimeSeconds: number | null;
  sensors: SwitchSensor[];
  ports: SwitchPort[];
  retentionDays: number;
  trafficIntervalSeconds: number;
  healthIntervalSeconds: number;
}
export interface NetworkSwitchesResponse { enabled:boolean;switches:NetworkSwitch[];error?:string }
export type SwitchHistoryRange = '1h' | '24h' | '7d';
export interface SwitchHistory {
  id: string;
  range: SwitchHistoryRange;
  start:number;end:number;step:number;
  trafficAggregation?: 'max';
  trafficSampleSeconds?: number;
  series: {id:string;name:string;label:string;kind:'rx'|'tx'|'temperature';unit:string;values:[number,number|null][]}[];
}
