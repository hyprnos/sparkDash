import type { DecodeBenchJob, PrefillBenchJob, QualityBenchJob } from "../../../api/types";
import { formatContextSize } from "../../../shared/prefillBench.js";
import { decodeBenchSamplingLabel } from "../../SparkPage/decodeSampling";

/** Translator shape for the run-history rows (see the `bench` catalog). */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Optional translator for a row builder. `Array.prototype.map` also passes the
 * index, so a plain number is accepted and ignored: `history.map(decodeHistoryRow)`
 * keeps working and stays English.
 */
type MaybeTranslate = Translate | number | undefined;

function translator(t: MaybeTranslate): Translate | undefined {
  return typeof t === "function" ? t : undefined;
}

/** One line of a bench page's run-history table. */
export interface HistoryRow {
  id: string;
  startedAt: number;
  status: "running" | "completed" | "failed" | "cancelled";
  /** Run label (quality) or the bench's own shape, e.g. "×1, 2, 4". */
  label: string;
  model: string | null;
  /** Endpoint port the run used, when the history spans several (quality). */
  port?: number | null;
  /** The number to compare runs by, already formatted. */
  headline: string;
  /** Secondary facts for the same run. */
  detail: string;
}

function aggregate(r: DecodeBenchJob["results"][number]): number {
  return r.aggregateDecodeTps > 0 ? r.aggregateDecodeTps : r.meanDecodeTps;
}

/** Peak aggregate decode tok/s over the levels that produced tokens. */
export function decodeHistoryRow(job: DecodeBenchJob, t?: MaybeTranslate): HistoryRow {
  const tr = translator(t);
  const ok = job.results.filter((r) => r.totalDecodeTokens > 0 || r.totalCompletionTokens > 0);
  const best = ok.reduce<DecodeBenchJob["results"][number] | null>(
    (b, r) => (b == null || aggregate(r) > aggregate(b) ? r : b),
    null
  );
  const single = ok.find((r) => r.concurrency === 1);
  return {
    id: job.benchId,
    startedAt: job.startedAt,
    status: job.status,
    label: `×${job.config.concurrencies.join(", ")}`,
    model: job.config.modelId ?? job.results.find((r) => r.model)?.model ?? null,
    headline: best ? (tr ? tr("historyRows.tps", { value: aggregate(best).toFixed(1) }) : `${aggregate(best).toFixed(1)} tok/s`) : "—",
    detail: [
      best ? (tr ? tr("historyRows.peakAt", { concurrency: best.concurrency }) : `peak at ×${best.concurrency}`) : null,
      single ? (tr ? tr("historyRows.perStreamAt1", { value: single.meanDecodeTps.toFixed(1) }) : `${single.meanDecodeTps.toFixed(1)}/stream at ×1`) : null,
      decodeBenchSamplingLabel(job.config, tr),
      job.config.contextTokens
        ? tr
          ? tr("historyRows.startCtx", { size: formatContextSize(job.config.contextTokens) })
          : `${formatContextSize(job.config.contextTokens)} start ctx`
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/** Fastest prefill tok/s over the context sizes that completed. */
export function prefillHistoryRow(job: PrefillBenchJob, t?: MaybeTranslate): HistoryRow {
  const tr = translator(t);
  const ok = job.results.filter((r) => r.prefillTps > 0);
  const best = ok.reduce<PrefillBenchJob["results"][number] | null>(
    (b, r) => (b == null || r.prefillTps > b.prefillTps ? r : b),
    null
  );
  const sizes = job.config.contextSizes;
  return {
    id: job.benchId,
    startedAt: job.startedAt,
    status: job.status,
    label: sizes.length ? sizes.map(formatContextSize).join(", ") : "—",
    model: job.config.modelId ?? job.results.find((r) => r.model)?.model ?? null,
    headline: best ? (tr ? tr("historyRows.tps", { value: best.prefillTps.toFixed(1) }) : `${best.prefillTps.toFixed(1)} tok/s`) : "—",
    detail: best
      ? tr
        ? tr("historyRows.bestAt", { size: formatContextSize(best.targetTokens) })
        : `best at ${formatContextSize(best.targetTokens)}`
      : "",
  };
}

export function qualityHistoryRow(job: QualityBenchJob, t?: MaybeTranslate): HistoryRow {
  const tr = translator(t);
  const overall = job.results?.overallPct;
  const cats = Object.keys(job.results?.categories ?? {}).length;
  return {
    id: job.benchId,
    startedAt: job.startedAt,
    status: job.status,
    label: job.config.label || "—",
    model: job.config.modelId ?? null,
    port: Number.isInteger(job.config.port) ? job.config.port : null,
    headline: overall == null ? "—" : tr ? tr("historyRows.percent", { value: overall.toFixed(1) }) : `${overall.toFixed(1)}%`,
    detail: cats
      ? tr
        ? cats === 1
          ? tr("historyRows.categoryOne", { count: cats })
          : tr("historyRows.categoryMany", { count: cats })
        : `${cats} categor${cats === 1 ? "y" : "ies"}`
      : "",
  };
}
