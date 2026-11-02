import type { QualityCategory } from "../../api/types";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Localized category name; the shared suite labels stay the canonical English names. */
export function qualityCategoryLabel(t: Translate, category: QualityCategory): string {
  switch (category) {
    case "reason":
      return t("qualityBench.catReason");
    case "arith":
      return t("qualityBench.catArith");
    case "track":
      return t("qualityBench.catTrack");
    case "gsm8k":
      return t("qualityBench.catGsm8k");
    case "mmlu":
      return t("qualityBench.catMmlu");
    case "follow":
      return t("qualityBench.catFollow");
    case "long":
      return t("qualityBench.catLong");
    default:
      return t("qualityBench.catQa");
  }
}

/** The one-line hint shown on the category picker card. */
export function qualityCategoryHint(t: Translate, category: QualityCategory): string {
  switch (category) {
    case "reason":
      return t("qualityBench.hintReason");
    case "arith":
      return t("qualityBench.hintArith");
    case "track":
      return t("qualityBench.hintTrack");
    case "gsm8k":
      return t("qualityBench.hintGsm8k");
    case "mmlu":
      return t("qualityBench.hintMmlu");
    case "follow":
      return t("qualityBench.hintFollow");
    case "long":
      return t("qualityBench.hintLong");
    default:
      return t("qualityBench.hintQa");
  }
}