/**
 * Showcase prompt catalogs by workload type.
 * Canonical lists live in src/shared/llmPrompts.js (also used by Decode bench).
 */

export type ShowcasePromptType = "structural" | "text" | "mixed";

/** Translator shape for the Showcase copy (see the `showcase` catalog). */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** English source for the prompt-type picker; `promptTypes` reads the catalog instead. */
export const PROMPT_TYPES: { id: ShowcasePromptType; label: string; hint: string }[] = [
  {
    id: "text",
    label: "Text",
    hint: "Prose / narrative — no code or structured formats",
  },
  {
    id: "structural",
    label: "Structural",
    hint: "JSON, HTML, YAML, SQL, schemas, tables, logs",
  },
  {
    id: "mixed",
    label: "Mixed",
    hint: "Half structural, half text — interleaved",
  },
];

/** Prompt-type picker copy from the `showcase` catalog; English when no translator is passed. */
export function promptTypes(t?: Translate): { id: ShowcasePromptType; label: string; hint: string }[] {
  if (!t) return PROMPT_TYPES;
  return [
    { id: "text", label: t("promptType.text"), hint: t("promptType.textHint") },
    { id: "structural", label: t("promptType.structural"), hint: t("promptType.structuralHint") },
    { id: "mixed", label: t("promptType.mixed"), hint: t("promptType.mixedHint") },
  ];
}

/** Translated name of a showcase stream/session status; unknown statuses stay as the server sent them. */
export function showcaseStatus(status: string, t?: Translate): string {
  if (!t) return status;
  switch (status) {
    case "pending":
      return t("status.pending");
    case "running":
      return t("status.running");
    case "completed":
      return t("status.completed");
    case "failed":
      return t("status.failed");
    case "cancelled":
      return t("status.cancelled");
    case "error":
      return t("status.error");
    default:
      return status;
  }
}

export {
  TEXT_PROMPTS,
  STRUCTURAL_PROMPTS,
  pickShowcasePrompts,
  withFillToMaxInstruction,
} from "../../shared/llmPrompts.js";
