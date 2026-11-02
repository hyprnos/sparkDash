import type { ActivityEvent } from "../../api/types";
import { configuredTimeZone } from "../../shared/timeZone";
import { i18n } from "../../i18n";

/** Pure logic for the Activity page: categories, labels, filtering, counts, day grouping, export. */

/** Translator shape shared by the page logic and the components. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export type Severity = ActivityEvent["severity"];

export const SEVERITIES: readonly Severity[] = ["error", "warn", "success", "info"];

/**
 * English severity names. Kept for callers without a translator; the page reads
 * `severityLabel` from the `activity` catalog instead.
 */
export const SEVERITY_LABEL: Record<Severity, string> = {
  error: "Error",
  warn: "Warning",
  success: "Success",
  info: "Info",
};

/** Translated severity name ("Error", "Warning", …). */
export function severityLabel(severity: Severity, t?: Translate): string {
  if (!t) return SEVERITY_LABEL[severity] ?? severity;
  switch (severity) {
    case "error":
      return t("severity.error");
    case "warn":
      return t("severity.warn");
    case "success":
      return t("severity.success");
    default:
      return t("severity.info");
  }
}

export type CategoryId = "status" | "thermal" | "health" | "alerts" | "hermes" | "bench" | "power" | "llm" | "fleet" | "other";

/** The filter's category ids; their names come from the `activity` catalog (`categories.*`). */
export const CATEGORIES: readonly { id: CategoryId }[] = [
  { id: "status" },
  { id: "thermal" },
  { id: "health" },
  { id: "alerts" },
  { id: "hermes" },
  { id: "bench" },
  { id: "power" },
  { id: "llm" },
  { id: "fleet" },
  { id: "other" },
];

/** One catalog key per category. */
const CATEGORY_KEY: Record<CategoryId, string> = {
  status: "categories.status",
  thermal: "categories.thermal",
  health: "categories.health",
  alerts: "categories.alerts",
  hermes: "categories.hermes",
  bench: "categories.bench",
  power: "categories.power",
  llm: "categories.llm",
  fleet: "categories.fleet",
  other: "categories.other",
};

/** English copy for callers without a translator: the en `activity` catalog is the source. */
function englishActivityT(): Translate {
  return i18n.getFixedT("en", "activity") as unknown as Translate;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Spark filter value for events that belong to no Spark. */
export const NO_SPARK = "__none__";

export type RangeId = "24h" | "7d" | "all";

export interface ActivityFilter {
  /** Empty = every severity. */
  severities: Severity[];
  category: CategoryId | "all";
  /** Spark id, NO_SPARK, or "all". */
  sparkId: string;
  query: string;
  range: RangeId;
}

export const EMPTY_FILTER: ActivityFilter = { severities: [], category: "all", sparkId: "all", query: "", range: "all" };

export function isFilterActive(f: ActivityFilter): boolean {
  return f.severities.length > 0 || f.category !== "all" || f.sparkId !== "all" || f.query.trim() !== "" || f.range !== "all";
}

export function categorize(type: string): CategoryId {
  if (type === "spark.online" || type === "spark.offline") return "status";
  if (type === "spark.added" || type === "spark.removed") return "fleet";
  if (type.startsWith("gpu.throttle")) return "thermal";
  if (type.startsWith("health.")) return "health";
  if (type.startsWith("alert.")) return "alerts";
  if (type.startsWith("hermes.")) return "hermes";
  if (type.startsWith("bench.")) return "bench";
  if (type.startsWith("power.")) return "power";
  if (type.startsWith("llm.")) return "llm";
  return "other";
}

const KNOWN_LABELS: Record<string, string> = {
  "spark.online": "Online",
  "spark.offline": "Offline",
  "spark.added": "Spark added",
  "spark.removed": "Spark removed",
  "gpu.throttle.thermal": "Thermal throttle",
  "gpu.throttle.cleared": "Throttle cleared",
  "hermes.update.available": "Hermes update available",
  "hermes.update.success": "Hermes updated",
  "hermes.update.error": "Hermes update failed",
  "health.xid": "Xid error",
  "health.oom": "Out of memory kill",
  "health.thermal": "Running hot",
  "health.low-power": "Low power state",
  "health.memory": "Low memory",
  "health.concurrency": "Many models loaded",
  "health.link-speed": "Slow link",
  "health.roce-link": "RoCE link down",
  "health.roce-loss": "RoCE packet loss",
  "health.cleared": "Health OK",
  "alert.notify.sent": "Notification sent",
  "alert.notify.failed": "Notification failed",
  "power.shutdown": "Shutdown",
  "power.wake": "Wake",
};

const BENCH_NAME: Record<string, string> = { decode: "Decode bench", prefill: "Prefill bench", quality: "Quality bench" };
const BENCH_STAGE: Record<string, string> = { finished: "", failed: " failed", cancelled: " cancelled" };
const LLM_ACTION: Record<string, string> = { start: "LLM start", stop: "LLM stop", attach: "LLM attach" };

/** Catalog key per known event type; unknown types fall back to a readable form of the tag itself. */
const TYPE_KEY: Record<string, string> = {
  "spark.online": "type.sparkOnline",
  "spark.offline": "type.sparkOffline",
  "spark.added": "type.sparkAdded",
  "spark.removed": "type.sparkRemoved",
  "gpu.throttle.thermal": "type.thermalThrottle",
  "gpu.throttle.cleared": "type.throttleCleared",
  "hermes.update.available": "type.hermesUpdateAvailable",
  "hermes.update.success": "type.hermesUpdated",
  "hermes.update.error": "type.hermesUpdateFailed",
  "health.xid": "type.xidError",
  "health.oom": "type.outOfMemoryKill",
  "health.thermal": "type.runningHot",
  "health.low-power": "type.lowPowerState",
  "health.memory": "type.lowMemory",
  "health.concurrency": "type.manyModelsLoaded",
  "health.link-speed": "type.slowLink",
  "health.roce-link": "type.roceLinkDown",
  "health.roce-loss": "type.rocePacketLoss",
  "health.cleared": "type.healthOk",
  "alert.notify.sent": "type.notificationSent",
  "alert.notify.failed": "type.notificationFailed",
  "power.shutdown": "type.shutdown",
  "power.wake": "type.wake",
};

const BENCH_NAME_KEY: Record<string, string> = { decode: "type.decodeBench", prefill: "type.prefillBench", quality: "type.qualityBench" };
const BENCH_STAGE_KEY: Record<string, string> = { finished: "type.stageFinished", failed: "type.stageFailed", cancelled: "type.stageCancelled" };
const LLM_ACTION_KEY: Record<string, string> = { start: "type.llmStart", stop: "type.llmStop", attach: "type.llmAttach" };

function sentence(s: string): string {
  const t = s.replace(/[._-]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Event";
}

/**
 * Short human label for a type tag, e.g. "bench.decode.finished" -> "Decode bench".
 * Without a translator the English table above is used, so the server and older
 * callers keep their English; the page passes the `activity` catalog translator.
 */
export function typeLabel(type: string, t?: Translate): string {
  if (t && TYPE_KEY[type]) return t(TYPE_KEY[type]);
  if (KNOWN_LABELS[type]) return KNOWN_LABELS[type];
  const parts = type.split(".");
  if (parts[0] === "bench" && parts.length === 3 && BENCH_NAME[parts[1]] && parts[2] in BENCH_STAGE) {
    const name = t ? t(BENCH_NAME_KEY[parts[1]]) : BENCH_NAME[parts[1]];
    return t ? t(BENCH_STAGE_KEY[parts[2]], { name }) : name + BENCH_STAGE[parts[2]];
  }
  if (parts[0] === "llm" && parts.length === 3 && LLM_ACTION[parts[1]]) {
    return t ? t("type.llmNamed", { action: t(LLM_ACTION_KEY[parts[1]]), target: parts[2] }) : `${LLM_ACTION[parts[1]]} ${parts[2]}`;
  }
  return sentence(type);
}

export function categoryLabel(id: CategoryId, t?: Translate): string {
  return (t ?? englishActivityT())(CATEGORY_KEY[id]);
}

/** Newest first by id (ids are monotonic), ts as a tiebreak for odd inputs. */
function byNewest(a: ActivityEvent, b: ActivityEvent): number {
  return b.id - a.id || b.ts - a.ts;
}

/** Merge a page of events into a list: dedupe by id (incoming wins), newest first. */
export function mergeEvents(current: readonly ActivityEvent[], incoming: readonly ActivityEvent[]): ActivityEvent[] {
  const map = new Map<number, ActivityEvent>();
  for (const e of current) map.set(e.id, e);
  for (const e of incoming) map.set(e.id, e);
  return [...map.values()].sort(byNewest);
}

export function sparkKey(e: ActivityEvent): string {
  return e.sparkId ? e.sparkId : NO_SPARK;
}

function rangeCutoff(range: RangeId, now: number): number {
  return range === "24h" ? now - DAY_MS : range === "7d" ? now - 7 * DAY_MS : -Infinity;
}

type Dim = keyof ActivityFilter;

function matches(e: ActivityEvent, f: ActivityFilter, now: number, skip?: Dim, t?: Translate): boolean {
  if (skip !== "severities" && f.severities.length > 0 && !f.severities.includes(e.severity)) return false;
  if (skip !== "category" && f.category !== "all" && categorize(e.type) !== f.category) return false;
  if (skip !== "sparkId" && f.sparkId !== "all" && sparkKey(e) !== f.sparkId) return false;
  if (skip !== "range" && e.ts < rangeCutoff(f.range, now)) return false;
  if (skip !== "query") {
    const q = f.query.trim().toLowerCase();
    if (q) {
      const hay = `${e.message}\n${e.sparkName ?? ""}\n${e.type}\n${typeLabel(e.type, t)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
  }
  return true;
}

/** Events matching every active filter dimension (order preserved). */
export function filterEvents(events: readonly ActivityEvent[], f: ActivityFilter, now: number = Date.now(), t?: Translate): ActivityEvent[] {
  return events.filter((e) => matches(e, f, now, undefined, t));
}

/** Faceted counts: each dimension is counted with all the OTHER filters applied. */
export function countBySeverity(events: readonly ActivityEvent[], f: ActivityFilter, now: number = Date.now()): Record<Severity, number> {
  const out: Record<Severity, number> = { error: 0, warn: 0, success: 0, info: 0 };
  for (const e of events) if (matches(e, f, now, "severities") && e.severity in out) out[e.severity]++;
  return out;
}

export function countByCategory(events: readonly ActivityEvent[], f: ActivityFilter, now: number = Date.now()): Record<CategoryId, number> {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0])) as Record<CategoryId, number>;
  for (const e of events) if (matches(e, f, now, "category")) out[categorize(e.type)]++;
  return out;
}

export function countBySpark(events: readonly ActivityEvent[], f: ActivityFilter, now: number = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) if (matches(e, f, now, "sparkId")) out[sparkKey(e)] = (out[sparkKey(e)] ?? 0) + 1;
  return out;
}

export interface SparkOption {
  id: string;
  name: string;
}

/** Sparks from the live list plus any ids only seen in events (removed Sparks), sorted by name. */
export function sparkOptions(
  sparks: readonly { id: string; name?: string | null }[],
  events: readonly ActivityEvent[]
): SparkOption[] {
  const map = new Map<string, string>();
  for (const s of sparks) map.set(s.id, s.name || s.id);
  for (const e of events) {
    if (e.sparkId && !map.has(e.sparkId)) map.set(e.sparkId, e.sparkName || e.sparkId);
  }
  return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

// ── Local-day handling ──────────────────────────────────────────────

const dtfCache = new Map<string, Intl.DateTimeFormat>();
/**
 * Date formatter for a calendar label. The dashboard's English source uses en-US
 * ("Monday, Oct 5"); a page that has an active locale passes it so weekdays and
 * months follow the reader's language.
 */
function dtf(key: string, tz: string | undefined, opts: Intl.DateTimeFormatOptions, locale?: string): Intl.DateTimeFormat {
  // No explicit zone: the Settings time zone, else the browser's.
  const zone = tz ?? configuredTimeZone() ?? undefined;
  const k = `${key}|${zone ?? ""}|${locale ?? ""}`;
  let f = dtfCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(locale || "en-US", { ...opts, timeZone: zone });
    dtfCache.set(k, f);
  }
  return f;
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function ymd(ts: number, tz?: string, locale?: string): Ymd {
  const parts = dtf("ymd", tz, { year: "numeric", month: "numeric", day: "numeric" }, locale).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const keyOf = ({ y, m, d }: Ymd) => `${y}-${pad2(m)}-${pad2(d)}`;
const dayNumber = ({ y, m, d }: Ymd) => Date.UTC(y, m - 1, d) / DAY_MS;

/** "YYYY-MM-DD" of the calendar day containing ts in `tz` (default: browser-local). */
export function localDayKey(ts: number, tz?: string): string {
  return keyOf(ymd(ts, tz));
}

function parseKey(key: string): Ymd {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d };
}

/** Format a day key with Intl options (the key is a plain calendar date, so UTC is exact). */
function formatDayKey(key: string, opts: Intl.DateTimeFormatOptions, locale?: string): string {
  const { y, m, d } = parseKey(key);
  return dtf(`dk${JSON.stringify(opts)}`, "UTC", opts, locale).format(new Date(Date.UTC(y, m - 1, d)));
}

function shiftKey(key: string, days: number): string {
  const { y, m, d } = parseKey(key);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return keyOf({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}

/** "Today", "Yesterday", else "Tuesday, Oct 7" (adds the year when it differs from now's). */
export function dayLabel(key: string, now: number = Date.now(), tz?: string, t?: Translate, locale?: string): string {
  const today = ymd(now, tz, locale);
  const diff = dayNumber(today) - dayNumber(parseKey(key));
  if (diff === 0) return t ? t("day.today") : "Today";
  if (diff === 1) return t ? t("day.yesterday") : "Yesterday";
  const sameYear = parseKey(key).y === today.y;
  return formatDayKey(key, sameYear ? { weekday: "long", month: "short", day: "numeric" } : { weekday: "long", month: "short", day: "numeric", year: "numeric" }, locale);
}

/** "14:05" 24-hour local time. */
export function formatClock(ts: number, tz?: string, locale?: string): string {
  return dtf("clock", tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, locale).format(new Date(ts));
}

/** "2026-10-07 14:05:09" in `tz`. */
export function formatStamp(ts: number, tz?: string): string {
  const parts = dtf("stamp", tz, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

export interface DayGroup {
  key: string;
  label: string;
  events: ActivityEvent[];
}

/** Group events (in the given order) by local day; groups keep first-seen order. */
export function groupByDay(events: readonly ActivityEvent[], now: number = Date.now(), tz?: string, t?: Translate, locale?: string): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const e of events) {
    const key = localDayKey(e.ts, tz);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: dayLabel(key, now, tz, t, locale), events: [] };
      groups.set(key, g);
    }
    g.events.push(e);
  }
  return [...groups.values()];
}

export interface DayBucket {
  key: string;
  /** Short axis label ("Oct 7"). */
  label: string;
  /** Tooltip heading ("Tue, Oct 7"). */
  title: string;
  counts: Record<Severity, number>;
}

/** One bucket per local day for the last `days` days (oldest first, today last), zero-filled. */
export function eventsPerDay(events: readonly ActivityEvent[], now: number = Date.now(), days = 14, tz?: string, locale?: string): DayBucket[] {
  const today = localDayKey(now, tz);
  const buckets: DayBucket[] = [];
  const index = new Map<string, DayBucket>();
  for (let i = days - 1; i >= 0; i--) {
    const key = shiftKey(today, -i);
    const b: DayBucket = {
      key,
      label: formatDayKey(key, { month: "short", day: "numeric" }, locale),
      title: formatDayKey(key, { weekday: "short", month: "short", day: "numeric" }, locale),
      counts: { error: 0, warn: 0, success: 0, info: 0 },
    };
    buckets.push(b);
    index.set(key, b);
  }
  for (const e of events) {
    const b = index.get(localDayKey(e.ts, tz));
    if (b && e.severity in b.counts) b.counts[e.severity]++;
  }
  return buckets;
}

export interface ActivitySummary {
  events24h: number;
  events7d: number;
  errors24h: number;
  errors7d: number;
  warnings24h: number;
  warnings7d: number;
  /** Sparks with at least one error or warning in the last 24 h. */
  problemSparks24h: number;
  problemSparks7d: number;
  mostActive: { sparkId: string; name: string; count: number } | null;
}

/** Headline numbers; the most active Spark is over the last 24 h, falling back to 7 d when quiet. */
export function summarize(events: readonly ActivityEvent[], now: number = Date.now()): ActivitySummary {
  const c24 = now - DAY_MS;
  const c7 = now - 7 * DAY_MS;
  const s: ActivitySummary = {
    events24h: 0, events7d: 0, errors24h: 0, errors7d: 0, warnings24h: 0, warnings7d: 0,
    problemSparks24h: 0, problemSparks7d: 0, mostActive: null,
  };
  const prob24 = new Set<string>();
  const prob7 = new Set<string>();
  const per24 = new Map<string, { name: string; count: number }>();
  const per7 = new Map<string, { name: string; count: number }>();
  const bump = (m: Map<string, { name: string; count: number }>, e: ActivityEvent) => {
    const k = e.sparkId as string;
    const cur = m.get(k);
    if (cur) cur.count++;
    else m.set(k, { name: e.sparkName || k, count: 1 });
  };
  for (const e of events) {
    if (e.ts < c7 || e.ts > now + HOUR_MS) continue;
    s.events7d++;
    const problem = e.severity === "error" || e.severity === "warn";
    if (e.severity === "error") s.errors7d++;
    if (e.severity === "warn") s.warnings7d++;
    if (problem && e.sparkId) prob7.add(e.sparkId);
    if (e.sparkId) bump(per7, e);
    if (e.ts >= c24) {
      s.events24h++;
      if (e.severity === "error") s.errors24h++;
      if (e.severity === "warn") s.warnings24h++;
      if (problem && e.sparkId) prob24.add(e.sparkId);
      if (e.sparkId) bump(per24, e);
    }
  }
  s.problemSparks24h = prob24.size;
  s.problemSparks7d = prob7.size;
  const best = (m: Map<string, { name: string; count: number }>) => {
    let top: ActivitySummary["mostActive"] = null;
    for (const [sparkId, v] of m) {
      if (!top || v.count > top.count || (v.count === top.count && v.name.localeCompare(top.name) < 0)) {
        top = { sparkId, name: v.name, count: v.count };
      }
    }
    return top;
  };
  s.mostActive = best(per24) ?? best(per7);
  return s;
}

/** Plain-text export, one line per event, in the order given. */
export function exportText(events: readonly ActivityEvent[], tz?: string, t?: Translate): string {
  return events
    .map((e) => {
      return `${formatStamp(e.ts, tz)} [${severityLabel(e.severity, t)}] ${typeLabel(e.type, t)} - ${e.message}`.replace(/\s+/g, " ");
    })
    .join("\n");
}
