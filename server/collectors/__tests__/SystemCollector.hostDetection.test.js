import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SystemCollector, parseAmdStrixSysfs } from "../SystemCollector.js";

const collector = (extra = {}) =>
  new SystemCollector({ id: "faex1", kind: "host", isLocal: false, ...extra });

test("Strix Halo sysfs also reports the GTT memory pool and current sclk", () => {
  const [gpu] = parseAmdStrixSysfs(
    "0,85,63000,89300000,43287193600,67076583424,237000704,536870912,2310000000\n"
  );
  assert.equal(gpu.usage, 85);
  assert.equal(gpu.temperature, 63);
  assert.equal(gpu.socPowerWatts, 89.3);
  assert.equal(gpu.smClockMHz, 2310);
  // An APU has no discrete VRAM: the pool is GTT + the BIOS-visible carve-out.
  assert.equal(gpu.vram.used, Math.round((43287193600 + 237000704) / 1048576));
  assert.equal(gpu.vram.total, Math.round((67076583424 + 536870912) / 1048576));
  assert.equal(gpu.metricAvailability.vramUsed, true);
  assert.equal(gpu.metricAvailability.vramTotal, true);
  assert.equal(gpu.metricAvailability.powerDraw, false);
  // SoC power stays out of the per-GPU draw so CPU power is not double counted.
  assert.equal(gpu.power.draw, 0);
});

test("Strix Halo sysfs keeps four-field legacy lines working", () => {
  const [gpu] = parseAmdStrixSysfs("0,99,82000,99813000");
  assert.equal(gpu.usage, 99);
  assert.equal(gpu.socPowerWatts, 99.8);
  assert.equal(gpu.smClockMHz, null);
  assert.equal(gpu.metricAvailability.vramTotal, false);
});

test("Strix Halo sysfs rejects non-numeric or out-of-range rows", () => {
  assert.deepEqual(parseAmdStrixSysfs("0,999,999999,9999999999\ninvalid\n,,\n"), []);
  assert.deepEqual(parseAmdStrixSysfs(""), []);
});

test("remote unified memory attributes GTT usage to the APU instead of zero", async () => {
  const c = collector();
  const output = [
    "MemTotal:       131008952 kB",
    "MemAvailable:   74333676 kB",
    "---",
    "---",
    "43287193600,237000704",
  ].join("\n");
  const memory = await c._getRemoteUnifiedMemory(async () => output);
  const systemUsedMB = Math.round((131008952 - 74333676) / 1024);
  const gpuUsedMB = Math.round((43287193600 + 237000704) / 1048576);
  assert.equal(memory.total, 127938);
  assert.equal(memory.used, systemUsedMB);
  assert.equal(memory.gpuUsed, gpuUsedMB);
  assert.equal(memory.cpuUsed, systemUsedMB - gpuUsedMB);
  assert.equal(memory.bandwidth.peak, 256);
});

test("remote unified memory keeps the NVIDIA path and its 400 GB/s ceiling", async () => {
  const c = collector();
  const output = [
    "MemTotal:       131008952 kB",
    "MemAvailable:   74333676 kB",
    "---",
    "1234,python,1000",
    "---",
    "",
  ].join("\n");
  const memory = await c._getRemoteUnifiedMemory(async () => output);
  assert.equal(memory.gpuUsed, 1000);
  assert.equal(memory.bandwidth.peak, 400);
});

test("remote network falls back to the default-route NIC MAC for Wake-on-LAN", async () => {
  const c = collector();
  const output = [
    // /proc/net/dev (no counters parsed: the array can stay empty)
    "",
    "---",
    // /proc/net/route — eno1 is the 0.0.0.0 default route
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
    "eno1\t00000000\t0A080101\t0003\t0\t0\t100\t00000000\t0\t0\t0",
    "---",
    // ip -4 addr show
    "3: eno1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP",
    "    inet 10.8.1.10/8 brd 10.255.255.255 scope global dynamic eno1",
    "---",
    // operstate
    "eno1:up",
    "---",
    // WOL_INTERFACE (enP7s7) is absent on this host
    "",
    "---",
    // link speed
    "eno1:2500",
    "---",
    // MAC per interface
    "eno1:70:70:fc:08:bf:19",
  ].join("\n");
  const net = await c._getRemoteNetwork(async () => output);
  assert.equal(net.primaryInterface, "eno1");
  assert.equal(net.linkSpeedMbps, 2500);
  assert.equal(net.wolMac, "70:70:fc:08:bf:19");
});

test("remote network prefers the DGX Spark WOL NIC when present", async () => {
  const c = collector();
  const output = [
    "",
    "---",
    "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
    "eno1\t00000000\t0A080101\t0003\t0\t0\t100\t00000000\t0\t0\t0",
    "---",
    "",
    "---",
    "",
    "---",
    "4c:bb:47:7f:95:fb",
    "---",
    "",
    "---",
    "eno1:70:70:fc:08:bf:19",
  ].join("\n");
  const net = await c._getRemoteNetwork(async () => output);
  assert.equal(net.wolMac, "4c:bb:47:7f:95:fb");
});

test("detectHardware names an AMD APU host from DMI and the CPU SKU", async () => {
  const c = collector();
  const output = [
    // nvidia-smi: absent on this host
    "",
    "---",
    "model name\t: AMD RYZEN AI MAX+ 395 w/ Radeon 8060S",
    "---",
    "32",
    "---",
    "MemTotal:       131008952 kB",
    "---",
    "FEVM",
    "FAEX1",
    "---",
    "ZHITAI TiPlus7100 2TB",
    "---",
    "      1 0x1002",
  ].join("\n");
  const hardware = await c.detectHardware(async () => output);
  assert.equal(hardware.device, "FEVM FAEX1");
  assert.equal(hardware.cpuModel, "AMD RYZEN AI MAX+ 395 w/ Radeon 8060S");
  assert.equal(hardware.cpuCores, 32);
  assert.equal(hardware.totalMemoryGB, 125);
  assert.equal(hardware.gpuChip, "Radeon 8060S");
  assert.equal(hardware.gpuCount, 1);
  assert.equal(hardware.cudaDriver, null);
  assert.equal(hardware.storageModel, "ZHITAI TiPlus7100 2TB");
  // Same shared-pool path as a GB10 Spark, so the UI never splits RAM and VRAM.
  assert.equal(hardware.memoryArchitecture, "unified");
});

test("detectHardware keeps the NVIDIA description when nvidia-smi answers", async () => {
  const c = collector();
  const output = [
    "NVIDIA DGX Spark, 580.65.06",
    "---",
    "model name\t: NVIDIA GB10",
    "---",
    "20",
    "---",
    "MemTotal:       134217728 kB",
    "---",
    "",
    "",
    "---",
    "",
    "---",
    "",
  ].join("\n");
  const hardware = await c.detectHardware(async () => output);
  assert.equal(hardware.gpuChip, "NVIDIA DGX Spark");
  assert.equal(hardware.gpuCount, 1);
  assert.equal(hardware.cudaDriver, "580.65.06");
  assert.equal(hardware.device, "Linux GPU host");
  // No iGPU sharing detected: keep the discrete model.
  assert.equal(hardware.memoryArchitecture, "discrete");
});
