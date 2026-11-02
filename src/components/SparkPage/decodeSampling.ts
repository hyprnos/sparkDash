import type { DecodeBenchConfig } from "../../api/types";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** "temp 0.7 · thinking on". Runs saved before these options existed ran at temp 0 with thinking off. */
export function decodeBenchSamplingLabel(
  config: Pick<DecodeBenchConfig, "temperature" | "thinking"> | null | undefined,
  t?: Translate
): string {
  const temp = typeof config?.temperature === "number" ? config.temperature : 0;
  const thinking = typeof config?.thinking === "boolean" ? config.thinking : false;
  if (!t) return `temp ${temp} · thinking ${thinking ? "on" : "off"}`;
  return t("decodeBench.sampling", {
    temperature: temp,
    thinking: thinking ? t("decodeBench.thinkingOn") : t("decodeBench.thinkingOff"),
  });
}

/** True when the runs used more than one temperature / thinking setting, so their tok/s are not comparable. */
export function decodeBenchSamplingMixed(configs: Array<Pick<DecodeBenchConfig, "temperature" | "thinking"> | null | undefined>): boolean {
  return new Set(configs.map((c) => decodeBenchSamplingLabel(c))).size > 1;
}