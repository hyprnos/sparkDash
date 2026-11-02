/**
 * Every benchmark sparkDash has a page for (sidebar "Benchmarks" section).
 * Throughput, speculative decoding, context pressure, needle and decision-model runs are not
 * separate pages: their options live under Tool Eval > Advanced > "Advanced / all options".
 * `engine` says what runs it: sparkDash's own benches (decode / prefill / quality) or the
 * external tool-eval-bench CLI executed on the Spark.
 */
import { i18n } from "../../i18n";

export type BenchEngine = "sparkdash" | "tool-eval";

export interface BenchType {
  id: string;
  label: string;
  /** One line shown under the page title and in the palette. */
  blurb: string;
  engine: BenchEngine;
  /** Sidebar sub-heading it sits under. */
  family: "sparkDash" | "Tool Eval Bench";
}

/**
 * Catalog copy for the sidebar, the command palette and the page header. The
 * bench pages read their labels from the `bench` catalog through these getters,
 * so the shell's palette (which only knows BENCH_TYPES) is translated too; the
 * English string is the fallback while the catalog is unavailable.
 */
function catalogText(key: string, fallback: string): string {
  try {
    const t = i18n.getFixedT(null, "bench") as unknown as (k: string) => string;
    const text = t(key);
    return text === key ? fallback : text;
  } catch {
    return fallback;
  }
}

export const BENCH_TYPES: readonly BenchType[] = [
  {
    id: "decode",
    get label() {
      return catalogText("types.decode.label", "Decode");
    },
    get blurb() {
      return catalogText("types.decode.blurb", "Generation speed (tokens/s) at rising concurrency.");
    },
    engine: "sparkdash",
    family: "sparkDash",
  },
  {
    id: "prefill",
    get label() {
      return catalogText("types.prefill.label", "Prefill");
    },
    get blurb() {
      return catalogText("types.prefill.blurb", "Prompt processing speed and time to first token across context sizes.");
    },
    engine: "sparkdash",
    family: "sparkDash",
  },
  {
    id: "quality",
    get label() {
      return catalogText("types.quality.label", "Quality");
    },
    get blurb() {
      return catalogText("types.quality.blurb", "A fixed, seeded quality suite to compare models, quantisations and KV-cache formats.");
    },
    engine: "sparkdash",
    family: "sparkDash",
  },
  {
    id: "tool-eval",
    get label() {
      return catalogText("types.toolEval.label", "Tool Eval Bench");
    },
    get blurb() {
      return catalogText("types.toolEval.blurb", "Tool-calling quality across 69 deterministic scenarios (selection, parameters, multi-step, safety).");
    },
    engine: "tool-eval",
    family: "Tool Eval Bench",
  },
];

const BY_ID = new Map(BENCH_TYPES.map((b) => [b.id, b]));

export function benchTypeById(id: string | null | undefined): BenchType | null {
  return (id && BY_ID.get(id)) || null;
}

/** localStorage key remembering which Spark the benchmark pages act on. */
export const BENCH_SPARK_KEY = "sparkdash.bench.spark";
