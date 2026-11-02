/** Small formatting helpers for the Tool Eval pages (pure, unit-tested). */

/** Translator shape for the Tool Eval copy (see the `bench` catalog). */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** 75 -> "1m 15s", 3700 -> "1h 01m". Without a translator the English units are used. */
export function fmtDuration(seconds: number | null | undefined, t?: Translate): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "–";
  const s = Math.round(seconds);
  if (s < 60) return t ? t("te.units.seconds", { value: s }) : `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    return t
      ? t("te.units.minutes", { minutes: m, seconds: String(s % 60).padStart(2, "0") })
      : `${m}m ${String(s % 60).padStart(2, "0")}s`;
  }
  return t
    ? t("te.units.hours", { hours: Math.floor(m / 60), minutes: String(m % 60).padStart(2, "0") })
    : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Rough time left from progress so far; null until at least one item finished. */
export function estimateRemaining(elapsedSeconds: number, done: number, total: number | null | undefined): number | null {
  if (!total || total <= 0 || done <= 0 || done >= total || elapsedSeconds <= 0) return null;
  return (elapsedSeconds / done) * (total - done);
}

export function fmtNum(v: unknown, digits = 2): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return v == null ? "–" : String(v);
  if (Number.isInteger(v)) return Math.abs(v) >= 10000 ? v.toLocaleString() : String(v);
  const abs = Math.abs(v);
  const d = abs >= 100 ? 1 : abs >= 10 ? Math.min(digits, 2) : digits;
  return Number(v.toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d });
}

export function fmtDate(ms: number | null | undefined): string {
  if (!ms) return "–";
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KiB`;
}

/** "tokens_per_second" -> "Tokens per second"; "ttftMs" -> "Ttft ms". */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : key;
}

export type Tier = { label: string; stars: number; tone: "good" | "info" | "warn" | "bad" };

/** The tool's score tiers: 90+ Excellent, 75+ Good, 60+ Adequate, 40+ Weak, else Poor. */
export function scoreTier(score: number | null | undefined, t?: Translate): Tier | null {
  if (score == null || !Number.isFinite(score)) return null;
  if (score >= 90) return { label: t ? t("te.tier.excellent") : "Excellent", stars: 5, tone: "good" };
  if (score >= 75) return { label: t ? t("te.tier.good") : "Good", stars: 4, tone: "good" };
  if (score >= 60) return { label: t ? t("te.tier.adequate") : "Adequate", stars: 3, tone: "info" };
  if (score >= 40) return { label: t ? t("te.tier.weak") : "Weak", stars: 2, tone: "warn" };
  return { label: t ? t("te.tier.poor") : "Poor", stars: 1, tone: "bad" };
}

export function toneColor(tone: Tier["tone"] | "neutral"): string {
  switch (tone) {
    case "good":
      return "var(--color-success)";
    case "info":
      return "var(--color-info)";
    case "warn":
      return "var(--color-warning)";
    case "bad":
      return "var(--color-danger)";
    default:
      return "var(--color-accent)";
  }
}

/** Plain-language explanation of the error codes the tool reports on its progress stream. */
export function explainErrorCode(code: string | null | undefined, message?: string | null, t?: Translate): string {
  const c = (code ?? "").toLowerCase();
  const tail = message ? (t ? t("te.error.tail", { message }) : ` (${message})`) : "";
  const known = (key: string, english: string) => (t ? `${t(key)}${tail}` : `${english}${tail}`);
  if (c === "no_server") return known("te.error.noServer", "No model server was found. Start the model on this Spark (or set a base URL) and try again.");
  if (c === "connection_failed") return known("te.error.connectionFailed", "The tool could not reach the model server. Check the URL, the port and that the server is running.");
  if (c === "no_models") return known("te.error.noModels", "The server answered but lists no models. Load a model first, or set the model name explicitly.");
  if (c === "auth_failed" || c === "unauthorized") return known("te.error.authFailed", "The server rejected the API key. Enter the right key or save one for this port.");
  if (c === "model_not_found") return known("te.error.modelNotFound", "The server does not serve that model name. Leave the model empty to auto-detect it.");
  if (message) return `${code}: ${message}`;
  return t ? t(code ? "te.error.genericWithCode" : "te.error.generic", { code: code ?? "" }) : `The tool reported an error${code ? ` (${code})` : ""}.`;
}

export interface ToolNote {
  /** Stable key for React. */
  key: string;
  text: string;
}

/**
 * Plain-language notes for messages the tool prints about what the model server does not support.
 * They are not failures (the run carries on), but the raw lines ("returned 400", "rejected") read like errors.
 * Pass the run's output lines; returns nothing when there is nothing to explain.
 */
export function toolNotes(lines: readonly { text: string }[], t?: Translate): ToolNote[] {
  const notes: ToolNote[] = [];
  const seen = new Set<string>();
  const add = (key: string, text: string) => {
    if (!seen.has(key)) {
      seen.add(key);
      notes.push({ key, text });
    }
  };
  const excluded: string[] = [];
  let forcedToolCalls = false;
  for (const { text } of lines) {
    if (/tool_choice/i.test(text) && /(rejected|not supported|unsupported|does not enforce)/i.test(text)) forcedToolCalls = true;
    const m = /Excluding\s+(TC-\d+)\s+from scoring/i.exec(text);
    if (m && !excluded.includes(m[1])) excluded.push(m[1]);
  }
  if (forcedToolCalls) {
    const which = excluded.length ? ` (${excluded.join(", ")})` : "";
    add(
      "tool-choice",
      t
        ? t(excluded.length === 1 ? "te.notes.toolChoiceOne" : "te.notes.toolChoiceMany", { scenarios: excluded.join(", ") || "—" })
        : `This model server does not support forced tool calls (tool_choice "required"), so the scenario${excluded.length === 1 ? "" : "s"} that need${excluded.length === 1 ? "s" : ""} it ${excluded.length === 1 ? "was" : "were"} left out of the score${which}. The run is fine; the score covers the other scenarios, so it is not directly comparable with a server that supports it.`
    );
  } else if (excluded.length) {
    add(
      "excluded",
      t
        ? t(excluded.length === 1 ? "te.notes.excludedOne" : "te.notes.excludedMany", { scenarios: excluded.join(", ") })
        : `${excluded.join(", ")} ${excluded.length === 1 ? "was" : "were"} left out of the score by the tool (see the raw output for the reason).`
    );
  }
  return notes;
}
