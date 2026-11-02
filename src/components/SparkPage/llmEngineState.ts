import type { LlmMetrics } from "../../api/types";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface EngineStateLabel {
  text: string;
  /** Hover text; set when the value needs explaining. */
  title?: string;
  /** Render muted — the value is an absence, not a reading. */
  muted: boolean;
}

/**
 * The LLM panel's Engine tile. `gpuMemoryUtilization` carries the engine
 * state only where the probe fills it (vLLM's sleep gauge; SGLang and q27,
 * which are always resident, report Active). For the rest — TensorFold,
 * llama.cpp, … — a bare dash read like a failed probe, so the tile says the
 * backend does not report it. The dash is kept for "no LLM at all".
 */
export function engineStateLabel(llm: LlmMetrics | null | undefined, t?: Translate): EngineStateLabel {
  if (!llm) return { text: "—", muted: false };
  // A successful Strata probe requires a loaded engine. Idle means the model
  // is ready for work, not asleep; it has no vLLM-style sleep gauge.
  if (llm.backend === "strata") {
    return llm.available
      ? { text: t ? t("llm.engineStateActive") : "Active", muted: false }
      : { text: "—", muted: true };
  }
  if (llm.gpuMemoryUtilization == null) {
    return {
      text: t ? t("llm.engineStateNa") : "n/a",
      title: t ? t("llm.engineStateNaTitle") : "This backend does not report engine sleep state",
      muted: true,
    };
  }
  const sleeping = llm.gpuMemoryUtilization === 0;
  return {
    text: sleeping
      ? t ? t("llm.engineStateSleeping") : "Sleeping"
      : t ? t("llm.engineStateActive") : "Active",
    muted: false,
  };
}