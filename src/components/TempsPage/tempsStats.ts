/**
 * Pure helpers for the Temps page: range definitions and turning the server's
 * `gpu-history` arrays into drawable per-card temperature series (no React, no I/O).
 */
import type { GpuHistoryResponse } from "../../api/client";
import type { Pt } from "../SparkPage/chartMath";

export type TempsRange = "24h" | "7d";

/** Translator shape the page passes in; see `Translate` in TokensPage/tokenStats. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface TempsRangeDef {
  id: TempsRange;
  ms: number;
}

/** The windows the page can chart. Their labels live in the `temps` catalog. */
export const TEMPS_RANGES: TempsRangeDef[] = [
  { id: "24h", ms: 24 * 3600_000 },
  { id: "7d", ms: 7 * 24 * 3600_000 },
];

/** The selected range id, or the default when the stored preference is unknown. */
export function parseTempsRange(raw: string | null): TempsRange {
  return TEMPS_RANGES.some((r) => r.id === raw) ? (raw as TempsRange) : "24h";
}

export interface TempSeries {
  key: string;
  label: string;
  /** Celsius readings parallel to the response's `t` array; null where the card had no reading. */
  c: Array<number | null>;
}

/**
 * One temperature series per card on a multi-GPU host, or a single aggregate series
 * otherwise (a single card IS the aggregate, so "GPU 0" would say nothing new).
 * Labels come from the `temps` catalog; a card's own name is used when it has one.
 */
export function tempSeriesOf(resp: GpuHistoryResponse, t: Translate): TempSeries[] {
  if (resp.gpus && resp.gpus.length > 1) {
    return resp.gpus.map((g) => ({ key: `gpu${g.index}`, label: g.name || t("gpuIndex", { index: g.index }), c: g.c }));
  }
  return [{ key: "agg", label: t("gpuTemperature"), c: resp.c }];
}

/** Pair timestamps with temperatures, dropping nulls so gaps become segment breaks. */
export function toPoints(t: readonly number[], c: ReadonlyArray<number | null>): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < t.length; i++) {
    const v = c[i];
    if (v == null || !Number.isFinite(v)) continue;
    out.push({ at: t[i], value: v });
  }
  return out;
}

/** "−24 h" / "−7 d" style relative axis labels from the catalog: [start, mid]; the page appends "now". */
export function tempsAxisLabels(windowMs: number, t: Translate): [string, string] {
  const fmt = (ms: number) => {
    const hours = ms / 3_600_000;
    if (hours >= 48) return t("axisDays", { days: Math.round((hours / 24) * 10) / 10 });
    return t("axisHours", { hours: Math.round(hours) });
  };
  return [fmt(windowMs), fmt(windowMs / 2)];
}
