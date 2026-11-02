import type { SparkSnapshot } from "../api/types";

export type FleetExceptionId = "offline" | "throttle" | "disk" | "llm" | "tailnet";

export interface FleetException {
  id: FleetExceptionId;
  label: string;
  detail?: string;
  severity: "critical" | "warning";
}

export function formatTemperature(c: number, unit?: "celsius" | "fahrenheit"): string;
/** The optional translator reads the labels from the `bench` catalog. */
export function fleetExceptions(
  spark: SparkSnapshot,
  unit?: "celsius" | "fahrenheit",
  t?: (key: string, vars?: Record<string, string | number>) => string
): FleetException[];
