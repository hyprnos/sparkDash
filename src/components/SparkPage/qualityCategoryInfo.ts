import type { QualityCategory } from "../../api/types";

/** Plain-language explanation of one Quality category, shown under "How it works". */
export interface QualityCategoryInfo {
  /** What a good score says about the model. */
  measures: string;
  /** What is sent and how. */
  how: string;
  /** How a reply becomes pass / fail. */
  scoring: string;
  /** A prompt of the kind the category sends (shortened where the real ones are long). */
  example: string;
  /** Run settings and rough cost. */
  settings: string;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * The catalog copy for every category's "How it works" panel. One static key per
 * sentence; the English source lives in locales/en/spark.json.
 */
export function qualityCategoryInfo(t: Translate): Record<QualityCategory, QualityCategoryInfo> {
  return {
    qa: {
      measures: t("qualityBench.info.qa.measures"),
      how: t("qualityBench.info.qa.how"),
      scoring: t("qualityBench.info.qa.scoring"),
      example: t("qualityBench.info.qa.example"),
      settings: t("qualityBench.info.qa.settings"),
    },
    reason: {
      measures: t("qualityBench.info.reason.measures"),
      how: t("qualityBench.info.reason.how"),
      scoring: t("qualityBench.info.reason.scoring"),
      example: t("qualityBench.info.reason.example"),
      settings: t("qualityBench.info.reason.settings"),
    },
    arith: {
      measures: t("qualityBench.info.arith.measures"),
      how: t("qualityBench.info.arith.how"),
      scoring: t("qualityBench.info.arith.scoring"),
      example: t("qualityBench.info.arith.example"),
      settings: t("qualityBench.info.arith.settings"),
    },
    track: {
      measures: t("qualityBench.info.track.measures"),
      how: t("qualityBench.info.track.how"),
      scoring: t("qualityBench.info.track.scoring"),
      example: t("qualityBench.info.track.example"),
      settings: t("qualityBench.info.track.settings"),
    },
    gsm8k: {
      measures: t("qualityBench.info.gsm8k.measures"),
      how: t("qualityBench.info.gsm8k.how"),
      scoring: t("qualityBench.info.gsm8k.scoring"),
      example: t("qualityBench.info.gsm8k.example"),
      settings: t("qualityBench.info.gsm8k.settings"),
    },
    mmlu: {
      measures: t("qualityBench.info.mmlu.measures"),
      how: t("qualityBench.info.mmlu.how"),
      scoring: t("qualityBench.info.mmlu.scoring"),
      example: t("qualityBench.info.mmlu.example"),
      settings: t("qualityBench.info.mmlu.settings"),
    },
    follow: {
      measures: t("qualityBench.info.follow.measures"),
      how: t("qualityBench.info.follow.how"),
      scoring: t("qualityBench.info.follow.scoring"),
      example: t("qualityBench.info.follow.example"),
      settings: t("qualityBench.info.follow.settings"),
    },
    long: {
      measures: t("qualityBench.info.long.measures"),
      how: t("qualityBench.info.long.how"),
      scoring: t("qualityBench.info.long.scoring"),
      example: t("qualityBench.info.long.example"),
      settings: t("qualityBench.info.long.settings"),
    },
  };
}