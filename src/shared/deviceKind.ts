import type { SparkConfig, SparkSnapshot } from "../api/types";
import { DEVICE_CLASS, deviceClassOf } from "./deviceClass.js";

/** Short noun for a unit kind, matching the "Spark/GPU Host" wording used elsewhere. */
export function deviceKindNoun(kind: SparkConfig["kind"]): "Spark" | "GPU Host" {
  return kind === "host" ? "GPU Host" : "Spark";
}

/** The choices in the Unit type select. */
export type UnitType = "spark" | "host" | "windows";

export const UNIT_TYPE_OPTIONS: { value: UnitType; label: string }[] = [
  { value: "spark", label: "NVIDIA DGX Spark" },
  { value: "host", label: "Dedicated GPU host (Linux, NVIDIA or AMD, not a Spark)" },
  { value: "windows", label: "Windows PC (NVIDIA GPU or AMD Strix Halo)" },
];

export function unitTypeOf(config: Pick<SparkConfig, "kind" | "platform">): UnitType {
  if (config.platform === "windows") return "windows";
  return config.kind === "host" ? "host" : "spark";
}

/** Config fields to set when the Unit type select changes. */
export function unitTypePatch(type: UnitType, current: Pick<SparkConfig, "platform">): Partial<SparkConfig> {
  if (type === "windows") return { kind: "host", platform: "windows", isLocal: false };
  // Keep a macOS platform set through the API; everything else is plain Linux.
  const platform = current.platform === "darwin" ? "darwin" : "linux";
  return { kind: type, platform };
}

/**
 * User-facing name for a unit, derived from what the collector detected.
 *
 * An AMD AI Max 395 is a peer of a DGX Spark (both share one memory pool with
 * their CPU), so it is named after itself rather than lumped in as "GPU Host".
 */
export function deviceKindLabel(
  unit: Pick<SparkSnapshot, "kind" | "platform" | "hardware">
): string {
  switch (deviceClassOf(unit)) {
    case DEVICE_CLASS.AMD_AI_MAX:
      return "AI Max 395";
    case DEVICE_CLASS.DGX_SPARK:
      return "Spark";
    case DEVICE_CLASS.WINDOWS_PC:
      return "Windows PC";
    case DEVICE_CLASS.MAC:
      return "Mac";
    default:
      return "GPU Host";
  }
}

/** Label for the final "add" button in the Add dialog. */
export function addDeviceLabel(kind: SparkConfig["kind"]): string {
  return `Add ${deviceKindNoun(kind)}`;
}

/** Title for the Edit dialog. */
export function editDeviceTitle(kind: SparkConfig["kind"]): string {
  return `Edit ${deviceKindNoun(kind)}`;
}
