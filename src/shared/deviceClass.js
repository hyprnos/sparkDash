/**
 * Device classes the dashboard treats as first-class targets.
 *
 * A "DGX Spark" and an "AMD AI Max 395" are both unified-memory boxes whose GPU
 * draws from the same pool as the CPU, so they must behave identically in every
 * panel (one "Unified memory" figure, no RAM/VRAM split) and carry their own
 * name in the fleet header. Anything else is a plain GPU host, a Windows PC or
 * a Mac.
 *
 * Shared by the browser and the server: the server needs the same judgement for
 * history sampling and Prometheus export, and this file is plain JS so both can
 * import it (see `src/shared/llmBackends.js` for the same pattern).
 */

export const DEVICE_CLASS = Object.freeze({
  DGX_SPARK: "dgx-spark",
  AMD_AI_MAX: "amd-ai-max",
  GPU_HOST: "gpu-host",
  WINDOWS_PC: "windows-pc",
  MAC: "mac",
});

/** Classes with one physical pool behind both the CPU and the GPU. */
const UNIFIED_CLASSES = new Set([DEVICE_CLASS.DGX_SPARK, DEVICE_CLASS.AMD_AI_MAX]);

/**
 * Is this an AMD APU (Strix Halo and friends)? The collector marks a host whose
 * iGPU allocates through the GTT window as `memoryArchitecture: "unified"`, and
 * the CPU SKU carries the Radeon name as the GPU label.
 * @param {{ memoryArchitecture?: string | null, gpuChip?: string | null, cpuModel?: string | null } | null | undefined} hardware
 */
export function isAmdApu(hardware) {
  if (hardware?.memoryArchitecture !== "unified") return false;
  return /radeon/i.test(`${hardware.gpuChip ?? ""} ${hardware.cpuModel ?? ""}`);
}

/**
 * Which class a unit belongs to.
 *
 * Hardware detection wins over the configured `kind`, because a generic Linux
 * "host" turns out to be an AI Max 395 only after the collector probes it.
 * @param {{
 *   kind?: string | null,
 *   platform?: string | null,
 *   hardware?: { memoryArchitecture?: string | null, gpuChip?: string | null, cpuModel?: string | null } | null
 * } | null | undefined} unit
 * @returns {import("../api/types").DeviceClass}
 */
export function deviceClassOf(unit) {
  if (unit?.platform === "windows") return DEVICE_CLASS.WINDOWS_PC;
  if (unit?.platform === "darwin") return DEVICE_CLASS.MAC;
  if (unit?.kind !== "host") return DEVICE_CLASS.DGX_SPARK;
  if (isAmdApu(unit?.hardware)) return DEVICE_CLASS.AMD_AI_MAX;
  return DEVICE_CLASS.GPU_HOST;
}

/**
 * Does the GPU draw from the same pool as the CPU?
 *
 * Prefers the detected architecture; before detection (or on a kind we cannot
 * probe) it falls back to the configured kind, where only a "host" is assumed
 * discrete. Never returns undefined, so callers always get a decision.
 * @param {{ kind?: string | null, platform?: string | null, hardware?: { memoryArchitecture?: string | null } | null } | null | undefined} unit
 * @returns {"unified" | "discrete"}
 */
export function memoryArchitectureOf(unit) {
  const detected = unit?.hardware?.memoryArchitecture;
  if (detected === "unified" || detected === "discrete") return detected;
  return unit?.kind === "host" ? "discrete" : "unified";
}

/** @param {import("../api/types").DeviceClass | string} deviceClass */
export function isUnifiedMemoryClass(deviceClass) {
  return UNIFIED_CLASSES.has(deviceClass);
}

/**
 * Does this unit share one memory pool between its CPU and GPU?
 * @param {{ kind?: string | null, platform?: string | null, hardware?: { memoryArchitecture?: string | null } | null } | null | undefined} unit
 */
export function sharesMemoryPool(unit) {
  return memoryArchitectureOf(unit) === "unified";
}

/** i18n key base for a class's name in the fleet header ("Spark", "AI Max 395"). */
export const DEVICE_CLASS_LABEL_KEY = Object.freeze({
  [DEVICE_CLASS.DGX_SPARK]: "spark",
  [DEVICE_CLASS.AMD_AI_MAX]: "amdAiMax",
  [DEVICE_CLASS.GPU_HOST]: "gpuHost",
  [DEVICE_CLASS.WINDOWS_PC]: "windowsPc",
  [DEVICE_CLASS.MAC]: "mac",
});