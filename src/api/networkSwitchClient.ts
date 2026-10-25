import { authHeaders, reportAuthRequired } from './authToken';
import type { NetworkSwitchesResponse, SwitchHistory, SwitchHistoryRange } from './networkSwitchTypes';
async function get<T>(path:string):Promise<T>{
 const response=await fetch(path,{headers:authHeaders(),signal:AbortSignal.timeout(10000)});
 if(!response.ok){if(response.status===401)reportAuthRequired();throw new Error('Switch monitoring unavailable');}
 return response.json();
}
export const fetchNetworkSwitches=()=>get<NetworkSwitchesResponse>('/api/network-switches');
export const fetchSwitchHistory=(id:string,range:SwitchHistoryRange)=>get<SwitchHistory>(`/api/network-switches/${encodeURIComponent(id)}/history?range=${range}`);
