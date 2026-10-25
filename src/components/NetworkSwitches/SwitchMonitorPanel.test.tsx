import {afterEach,expect,it,vi} from 'vitest';
import {act} from 'react';
import {SwitchMonitorPanel} from './SwitchMonitorPanel';
import {cleanupRenders,flush,render} from '../../testing/render';
import type {NetworkSwitch} from '../../api/networkSwitchTypes';
vi.mock('../../api/networkSwitchClient',()=>({fetchNetworkSwitches:vi.fn(),fetchSwitchHistory:vi.fn()}));
import {fetchNetworkSwitches,fetchSwitchHistory} from '../../api/networkSwitchClient';
const state={available:true,observedAt:Date.now(),ageMs:1000};
const device:NetworkSwitch={id:'crs812',name:'CRS812',address:'10.1.1.20',model:'CRS812',routeros:'7.25rc3',available:true,status:'online',observedAt:Date.now(),ageMs:1000,health:state,system:state,uptimeSeconds:3600,retentionDays:30,trafficIntervalSeconds:5,healthIntervalSeconds:30,sensors:[{name:'switch-temperature',label:'Switch ASIC',kind:'temperature',unit:'°C',scale:1,value:57}],ports:[{name:'qsfp56-dd-2-5',peer:'spark001',link:'up',speedBps:null,configuredSpeedBps:200e9,utilizationBasis:'configured',rxBps:10e9,txBps:0,rxUtilization:.05,txUtilization:0,rxErrors:null,txErrors:null,rxDiscards:null,txDiscards:null,rxErrorsPerSecond:null,txErrorsPerSecond:null}]};
afterEach(()=>{cleanupRenders();vi.useRealTimers();});
it('shows hardware traffic, directional utilisation and explicitly configured bandwidth; loads history only on expansion',async()=>{
 vi.mocked(fetchNetworkSwitches).mockResolvedValue({enabled:true,switches:[device]});
 vi.mocked(fetchSwitchHistory).mockResolvedValue({id:'crs812',range:'1h',start:0,end:15,step:15,series:[]});
 const {container}=render(<SwitchMonitorPanel/>);await flush();
 expect(container.textContent).toContain('57°C');expect(container.textContent).toContain('10.00 Gbps');expect(container.textContent).toContain('0 bps');expect(container.textContent).toContain('200 Gb/s configured');
 expect(fetchSwitchHistory).not.toHaveBeenCalled();
 act(()=>container.querySelector('button')!.click());await flush();
 expect(fetchSwitchHistory).toHaveBeenCalledWith('crs812','1h');expect(container.textContent).toContain('— / —');expect(container.querySelectorAll('[role=img]').length).toBeGreaterThan(0);
});
it('masks cached readings on stalled transport and recovers',async()=>{
 vi.useFakeTimers();vi.mocked(fetchNetworkSwitches).mockResolvedValue({enabled:true,switches:[device]});
 const {container}=render(<SwitchMonitorPanel/>);await flush();
 vi.mocked(fetchNetworkSwitches).mockReturnValue(new Promise(()=>{}));
 await act(async()=>vi.advanceTimersByTime(25000));
 expect(container.textContent).toContain('Stale');expect(container.textContent).not.toContain('57°C');expect(container.textContent).not.toContain('10.00 Gbps');expect(container.textContent).toContain('unknown');
});
it('hides optional panel when disabled',async()=>{
 vi.mocked(fetchNetworkSwitches).mockResolvedValue({enabled:false,switches:[]});
 const {container}=render(<SwitchMonitorPanel/>);await flush();expect(container.textContent).toBe('');
});
