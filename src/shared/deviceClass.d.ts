import type { DeviceClass } from "../api/types";

/**
 * Device classes the dashboard treats as first-class targets.
 * `dgx-spark` and `amd-ai-max` are peers: both share one memory pool.
 */
export declare const DEVICE_CLASS: {
  readonly DGX_SPARK: "dgx-spark";
  readonly AMD_AI_MAX: "amd-ai-max";
  readonly GPU_HOST: "gpu-host";
  readonly WINDOWS_PC: "windows-pc";
  readonly MAC: "mac";
};

export interface HardwareProbeLike {
  memoryArchitecture?: string | null;
  gpuChip?: string | null;
  cpuModel?: string | null;
}

export interface UnitIdentityLike {
  kind?: string | null;
  platform?: string | null;
  hardware?: HardwareProbeLike | null;
}

/** Is this an AMD APU whose iGPU allocates through the GTT window? */
export declare function isAmdApu(hardware?: HardwareProbeLike | null): boolean;

/** Which class a unit belongs to (detected hardware wins over `kind`). */
export declare function deviceClassOf(unit?: UnitIdentityLike | null): DeviceClass;

/** "unified" when the GPU draws from the CPU's pool, never undefined. */
export declare function memoryArchitectureOf(unit?: UnitIdentityLike | null): "unified" | "discrete";

/** True for the classes whose CPU and GPU share one physical pool. */
export declare function isUnifiedMemoryClass(deviceClass?: string | null): boolean;

/** Shorthand for `memoryArchitectureOf(unit) === "unified"`. */
export declare function sharesMemoryPool(unit?: UnitIdentityLike | null): boolean;

/** i18n key base for a class's label in the fleet header. */
export declare const DEVICE_CLASS_LABEL_KEY: Readonly<Record<DeviceClass, string>>;