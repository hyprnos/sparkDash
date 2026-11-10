import { describe, expect, it } from "vitest";
import {
  DEVICE_CLASS,
  deviceClassOf,
  isAmdApu,
  isUnifiedMemoryClass,
  memoryArchitectureOf,
  sharesMemoryPool,
} from "./deviceClass.js";

/** A probed AMD AI Max 395, as the collector reports it. */
const aiMax = {
  kind: "host",
  platform: "linux",
  hardware: {
    memoryArchitecture: "unified",
    gpuChip: "Radeon 8060S",
    cpuModel: "AMD RYZEN AI MAX+ 395 w/ Radeon 8060S",
  },
};

const dgxSpark = { kind: "spark", platform: "linux", hardware: { memoryArchitecture: "unified" } };

const rtxHost = {
  kind: "host",
  platform: "linux",
  hardware: { memoryArchitecture: "discrete", gpuChip: "NVIDIA RTX 5080" },
};

describe("deviceClassOf", () => {
  it("treats an AMD AI Max 395 as its own class, not a generic host", () => {
    expect(deviceClassOf(aiMax)).toBe(DEVICE_CLASS.AMD_AI_MAX);
    // Peers with a Spark: same shared-pool behaviour.
    expect(isUnifiedMemoryClass(deviceClassOf(aiMax))).toBe(true);
    expect(isUnifiedMemoryClass(deviceClassOf(dgxSpark))).toBe(true);
  });

  it("keeps a discrete-GPU Linux box a plain GPU host", () => {
    expect(deviceClassOf(rtxHost)).toBe(DEVICE_CLASS.GPU_HOST);
    expect(isUnifiedMemoryClass(deviceClassOf(rtxHost))).toBe(false);
  });

  it("classifies Windows and macOS units before looking at GPUs", () => {
    expect(deviceClassOf({ kind: "host", platform: "windows" })).toBe(DEVICE_CLASS.WINDOWS_PC);
    expect(deviceClassOf({ kind: "host", platform: "darwin" })).toBe(DEVICE_CLASS.MAC);
  });

  it("does not call an unprobed host an APU", () => {
    // No hardware yet: a "host" stays a host rather than guessing.
    expect(deviceClassOf({ kind: "host", platform: "linux" })).toBe(DEVICE_CLASS.GPU_HOST);
    expect(deviceClassOf({ kind: "host", platform: "linux", hardware: {} })).toBe(
      DEVICE_CLASS.GPU_HOST
    );
  });

  it("requires both the unified marker and a Radeon name", () => {
    // Unified but no Radeon in the label would be a GB10-shaped host.
    expect(isAmdApu({ memoryArchitecture: "unified", gpuChip: "GB10" })).toBe(false);
    expect(isAmdApu({ memoryArchitecture: "discrete", gpuChip: "Radeon 8060S" })).toBe(false);
    expect(isAmdApu(aiMax.hardware)).toBe(true);
  });
});

describe("sharesMemoryPool", () => {
  it("is true for a Spark and for a probed AI Max 395", () => {
    expect(sharesMemoryPool(dgxSpark)).toBe(true);
    expect(sharesMemoryPool(aiMax)).toBe(true);
  });

  it("is false for a discrete host", () => {
    expect(sharesMemoryPool(rtxHost)).toBe(false);
  });

  it("falls back to kind only while nothing is detected", () => {
    expect(memoryArchitectureOf({ kind: "spark" })).toBe("unified");
    expect(memoryArchitectureOf({ kind: "host" })).toBe("discrete");
    // Detection wins over the configured kind in both directions.
    expect(memoryArchitectureOf({ kind: "host", hardware: { memoryArchitecture: "unified" } })).toBe(
      "unified"
    );
    expect(memoryArchitectureOf({ kind: "spark", hardware: { memoryArchitecture: "discrete" } })).toBe(
      "discrete"
    );
  });
});