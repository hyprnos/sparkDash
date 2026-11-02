import { normalizeDecodeBenchType } from "../../shared/llmPrompts.js";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Localized name and one-line hint for a decode-bench prompt type. The shared
 * `DECODE_BENCH_TYPE_META` stays the source of truth for the ids and prompts;
 * only the words the dialog shows live in the `spark` catalog.
 */
export function decodeTypeLabel(t: Translate, type: unknown): string {
  switch (normalizeDecodeBenchType(type)) {
    case "prose":
      return t("decodeBench.typeProse");
    case "code":
      return t("decodeBench.typeCode");
    case "json":
      return t("decodeBench.typeJson");
    default:
      return t("decodeBench.typeStructured");
  }
}

export function decodeTypeHint(t: Translate, type: unknown): string {
  switch (normalizeDecodeBenchType(type)) {
    case "prose":
      return t("decodeBench.typeProseHint");
    case "code":
      return t("decodeBench.typeCodeHint");
    case "json":
      return t("decodeBench.typeJsonHint");
    default:
      return t("decodeBench.typeStructuredHint");
  }
}