import { i18n } from "../../../i18n";
import type { FieldValue } from "./options";
import type { Translate } from "./format";

/** A one-click preset: its ids and values only. The wording lives in the `bench` catalog. */
export interface Preset {
  id: string;
  values: Record<string, FieldValue>;
  /** Accuracy page only: which suites to tick. */
  suites?: string[];
}

/** A preset with its catalog copy resolved (`te.presets.<type>.<id>`). */
export interface PresetText extends Preset {
  label: string;
  help: string;
}

/**
 * English copy for callers that have no translator. The `bench` catalog is the
 * single source of the preset wording, so its `en` entries are the fallback.
 */
export function englishBenchT(): Translate {
  return i18n.getFixedT("en", "bench") as unknown as Translate;
}

/** Name and help text of one preset in the reader's language (key path `te.presets.<type>.<id>`). */
export function presetCopy(t: Translate | undefined, type: string, preset: Pick<Preset, "id">): { label: string; help: string } {
  const tr = t ?? englishBenchT();
  return { label: tr(`te.presets.${type}.${preset.id}.label`), help: tr(`te.presets.${type}.${preset.id}.help`) };
}

/** One-click starting points per page type. Applied on top of the page's defaults; copy comes from the `bench` catalog. */
export const PRESETS: Record<string, Preset[]> = {
  "tool-eval": [
    { id: "quick", values: { short: true } },
    { id: "full", values: {} },
    { id: "hard", values: { "hardmode-only": true } },
    { id: "repro", values: { temperature: "0", seed: "42" } },
    { id: "thinking", values: { "no-think": true, timeout: "120" } },
  ],
  throughput: [
    { id: "quick", values: { pp: "512", tg: "64", depth: "0", concurrency: "1", "benchy-runs": "1" } },
    { id: "standard", values: {} },
    { id: "deep", values: { depth: "0,4096,8192,16384,32768", concurrency: "1,2,4,8" } },
  ],
  "spec-decode": [
    { id: "quick", values: { "spec-runs": "1", "spec-prompts": "filler" } },
    { id: "standard", values: {} },
    { id: "code", values: { "spec-prompts": "code,structured" } },
  ],
  "context-pressure": [
    { id: "single", values: { "context-pressure": "0.75", short: true } },
    { id: "sweep", values: { "context-pressure-sweep": "0.5-1.0", "sweep-steps": "5", short: true } },
    { id: "fine", values: { "context-pressure-sweep": "0.1-1.0", "sweep-steps": "10", short: true } },
  ],
  accuracy: [
    { id: "quick", values: { "gsm8k-limit": "50", "mmlu-limit": "100", "ifeval-limit": "100" }, suites: ["gsm8k", "mmlu", "ifeval"] },
    { id: "standard", values: {}, suites: ["gsm8k", "mmlu", "ifeval"] },
    { id: "full", values: { "gsm8k-limit": "0", "mmlu-limit": "0", "ifeval-limit": "0" }, suites: ["gsm8k", "mmlu", "ifeval"] },
    { id: "repro", values: { seed: "42", "gsm8k-shuffle": true }, suites: ["gsm8k", "mmlu", "ifeval"] },
  ],
  needle: [
    { id: "quick", values: { "needle-depths": "3", "needle-lengths": "2" } },
    { id: "standard", values: {} },
    { id: "thorough", values: { "needle-depths": "10", "needle-lengths": "8" } },
  ],
  decision: [{ id: "standard", values: {} }],
};

/** A ready-made run shown as a card in the Simple view. */
export interface SimpleTemplate extends PresetText {
  /** Rough size, shown on the card. */
  size?: string;
  /** Rough time, shown on the card. */
  time?: string;
}

/** Tool Eval's four basics; all keep a fixed seed (42) so repeat runs stay comparable. */
const SIMPLE_TEMPLATES: readonly { id: string; values: Record<string, FieldValue> }[] = [
  { id: "regular", values: { seed: "42" } },
  { id: "regular-hard", values: { hardmode: true, seed: "42" } },
  { id: "short", values: { short: true, seed: "42" } },
  { id: "hard", values: { "hardmode-only": true, seed: "42" } },
];

/**
 * The Simple view's templates. Tool Eval gets four basics (regular, regular + hard
 * mode, short, hard mode only) from `te.templates.*`; the other pages offer their
 * ready presets as templates.
 */
export function simpleTemplates(type: string, t?: Translate): SimpleTemplate[] {
  if (type !== "tool-eval") return presetsFor(type, t);
  const tr = t ?? englishBenchT();
  return SIMPLE_TEMPLATES.map((template) => ({
    ...template,
    values: { ...template.values },
    label: tr(`te.templates.${template.id}.label`),
    help: tr(`te.templates.${template.id}.help`),
    size: tr(`te.templates.${template.id}.size`),
    time: tr(`te.templates.${template.id}.time`),
  }));
}

/** One-click presets with their catalog copy (`te.presets.<type>.<id>`). */
export function presetsFor(type: string, t?: Translate): PresetText[] {
  return (PRESETS[type] ?? []).map((preset) => ({ ...preset, ...presetCopy(t, type, preset) }));
}

/** Where the run points, not how it runs: a custom URL or model never makes a template "custom". */
export const TARGET_KEYS: ReadonlySet<string> = new Set(["base-url", "model"]);

/** Settings the Simple view keeps across templates: the target, and how many trials to repeat. */
export const KEPT_KEYS: ReadonlySet<string> = new Set([...TARGET_KEYS, "trials"]);

const normValue = (v: unknown): string => (Array.isArray(v) ? v.join(" ") : String(v ?? "")).trim();

/** Does the form currently hold exactly this template (and nothing else)? */
export function matchesTemplate(
  state: { values: Record<string, unknown>; extraArgs: string; suites: string[] },
  template: Preset
): boolean {
  if (state.extraArgs.trim()) return false;
  const set = (v: unknown) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.every((x) => !String(x).trim()));
  const keys = new Set([...Object.keys(state.values).filter((k) => set(state.values[k])), ...Object.keys(template.values).filter((k) => set(template.values[k]))]);
  for (const k of KEPT_KEYS) keys.delete(k);
  for (const k of keys) {
    if (set(state.values[k]) !== set(template.values[k])) return false;
    if (normValue(state.values[k]) !== normValue(template.values[k]) && String(state.values[k]) !== String(template.values[k])) return false;
  }
  if (template.suites) {
    const a = [...template.suites].sort().join(",");
    const b = [...state.suites].sort().join(",");
    if (a !== b) return false;
  }
  return true;
}

/** The non-blank KEPT_KEYS values of a form: what survives picking a template or preset. */
export function keptValues(values: Record<string, FieldValue>): Record<string, FieldValue> {
  return Object.fromEntries([...KEPT_KEYS].filter((k) => String(values[k] ?? "").trim()).map((k) => [k, values[k]]));
}