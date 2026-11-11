/**
 * EinkRuntime — pushes a fleet token summary onto a Bluetooth e-paper shelf tag.
 *
 * The Bluetooth link lives outside the container: `bridge/eink_bridge.py` runs on
 * the host (BlueZ + Pillow) and exposes a small HTTP API on loopback. This module
 * owns everything the dashboard side needs — persisted configuration, the scene
 * built from the token ledger, the refresh schedule and the browser routes.
 *
 * Kept local-only on purpose: index.js only needs createEinkRuntime().
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  DEFAULT_FX_CNY_PER_USD,
  OFFICIAL_SOURCE,
  listPriceModels,
  priceSnapshot,
  applyOfficialPricing,
  computeCostByHour,
  findOfficialModel,
  hourKeyToDate,
  isPeakHour,
  formatCny,
  parseOfficialPricing,
  resolveRates,
} from "./Pricing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

/** Sensor floor for a refresh: colour e-paper needs ~20 s per update and runs on a battery. */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 1440;
const MAX_BACKGROUND_BYTES = 4 * 1024 * 1024;
/** Kept in step with bridge/eink_bridge.py; the bridge reports its own list too. */
const DITHER_ALGORITHMS = [
  "none",
  "floyd-steinberg",
  "jarvis",
  "stucki",
  "burkes",
  "sierra",
  "sierra-lite",
  "atkinson",
  "bayer8",
  "blue-noise",
];
const TICK_MS = 60_000;
const RETRY_AFTER_ERROR_MS = 5 * 60_000;
const BRIDGE_TIMEOUT_MS = 120_000;

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  device: { address: "", name: "NRF_EPD_A568" },
  intervalMinutes: 30,
  pigment: "yellow",
  theme: "dark",
  sections: { headline: true, stats: true, rows: true, cost: true },
  background: null,
  backgroundDim: 0.35,
  /** Drawn as the tag's top line; empty falls back to "sparkDash". */
  title: "sparkDash",
  /** Footer override; "{time}" expands to the render time. Empty keeps the interval note. */
  footer: "",
  /** "auto" | "halo" | "plate" | "off" — text-over-photo handling. */
  textProtection: "auto",
  /** Background photo transform: 1.0 = cover fit, pan is a fraction of the canvas. */
  backgroundZoom: 1,
  backgroundOffsetX: 0,
  backgroundOffsetY: 0,
  backgroundBrightness: 0,
  backgroundContrast: 0,
  /** Dither engine for the photo (the UI layer is never dithered). */
  ditherAlgorithm: "floyd-steinberg",
  ditherStrength: 1,
  /** Hosted-API price used to price today's tokens (CNY per 1M tokens). */
  pricing: {
    modelId: "deepseek-flash",
    tariff: "auto",
    label: "",
    cacheHitPrice: 0,
    cacheMissPrice: 0,
    outputPrice: 0,
    fxRate: DEFAULT_FX_CNY_PER_USD,
    updatedAt: null,
    /** Named price books, assigned to endpoints below. */
    profiles: [],
    /** `{ sparkId, port?, modelId?, profileId }` — most specific rule wins. */
    assignments: [],
  },
  /** Outline thickness in panel pixels (1-4); the ring follows the glyph shape. */
  haloWidth: 3,
});

/** One sanitized price book; ids are stable strings so assignments can point at them. */
function normalizeProfile(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  const id = typeof source.id === "string" && source.id.trim() ? source.id.trim().slice(0, 40) : `profile-${index + 1}`;
  return {
    id,
    name: typeof source.name === "string" && source.name.trim() ? source.name.trim().slice(0, 40) : id,
    modelId: typeof source.modelId === "string" && source.modelId ? source.modelId : "deepseek-flash",
    tariff: ["auto", "peak", "off-peak"].includes(source.tariff) ? source.tariff : "auto",
    label: typeof source.label === "string" ? source.label.slice(0, 40) : "",
    cacheHitPrice: Math.max(0, Number(source.cacheHitPrice) || 0),
    cacheMissPrice: Math.max(0, Number(source.cacheMissPrice) || 0),
    outputPrice: Math.max(0, Number(source.outputPrice) || 0),
    fxRate: Math.min(20, Math.max(1, Number(source.fxRate) || DEFAULT_FX_CNY_PER_USD)),
  };
}

/** Rules that bind an endpoint (and optionally a model) to a price book. */
function normalizeAssignments(raw, profileIds) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const sparkId = typeof entry.sparkId === "string" ? entry.sparkId.trim().slice(0, 80) : "";
    const profileId = typeof entry.profileId === "string" ? entry.profileId.trim() : "";
    if (!sparkId || !profileIds.has(profileId)) continue;
    const port = Number(entry.port) || 0;
    const modelId = typeof entry.modelId === "string" ? entry.modelId.trim().slice(0, 120) : "";
    const key = `${sparkId}:${port}:${modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sparkId, port, modelId, profileId });
    if (out.length >= 100) break;
  }
  return out;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeBackground(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return null;
  /* basename only: the value arrives from the browser, so never trust a path */
  return { name: path.basename(name) };
}

/** Merge an untrusted patch onto the stored configuration, dropping unknown shapes. */
export function normalizeConfig(patch = {}, base = DEFAULT_CONFIG) {
  const next = {
    enabled: patch.enabled === undefined ? base.enabled : Boolean(patch.enabled),
    device: { ...base.device },
    intervalMinutes:
      patch.intervalMinutes === undefined
        ? base.intervalMinutes
        : clampNumber(patch.intervalMinutes, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, base.intervalMinutes),
    pigment: ["yellow", "red"].includes(patch.pigment) ? patch.pigment : base.pigment,
    theme: ["dark", "light"].includes(patch.theme) ? patch.theme : base.theme,
    sections: { ...base.sections },
    pricing: { ...(base.pricing || DEFAULT_CONFIG.pricing) },
    background: patch.background === undefined ? base.background : normalizeBackground(patch.background),
    backgroundDim:
      patch.backgroundDim === undefined
        ? base.backgroundDim
        : Math.min(0.9, Math.max(0, Number(patch.backgroundDim) || 0)),
    title:
      patch.title === undefined ? base.title : String(patch.title).trim().slice(0, 24),
    footer:
      patch.footer === undefined ? base.footer : String(patch.footer).trim().slice(0, 48),
    textProtection: ["auto", "halo", "plate", "off"].includes(patch.textProtection)
      ? patch.textProtection
      : patch.textProtection === "band" || patch.textProtection === "scrim"
        ? "auto"
        : base.textProtection,
    backgroundZoom:
      patch.backgroundZoom === undefined
        ? base.backgroundZoom
        : Math.min(4, Math.max(1, Number(patch.backgroundZoom) || 1)),
    backgroundOffsetX:
      patch.backgroundOffsetX === undefined
        ? base.backgroundOffsetX
        : Math.min(1, Math.max(-1, Number(patch.backgroundOffsetX) || 0)),
    backgroundOffsetY:
      patch.backgroundOffsetY === undefined
        ? base.backgroundOffsetY
        : Math.min(1, Math.max(-1, Number(patch.backgroundOffsetY) || 0)),
    backgroundBrightness:
      patch.backgroundBrightness === undefined
        ? base.backgroundBrightness
        : clampNumber(patch.backgroundBrightness, -100, 100, base.backgroundBrightness),
    backgroundContrast:
      patch.backgroundContrast === undefined
        ? base.backgroundContrast
        : clampNumber(patch.backgroundContrast, -100, 100, base.backgroundContrast),
    ditherAlgorithm:
      typeof patch.ditherAlgorithm === "string" && DITHER_ALGORITHMS.includes(patch.ditherAlgorithm)
        ? patch.ditherAlgorithm
        : base.ditherAlgorithm,
    ditherStrength:
      patch.ditherStrength === undefined
        ? base.ditherStrength
        : Math.min(1, Math.max(0, Number(patch.ditherStrength))),
    haloWidth:
      patch.haloWidth === undefined ? base.haloWidth : clampNumber(patch.haloWidth, 1, 4, base.haloWidth),
  };
  if (patch.device && typeof patch.device === "object") {
    next.device = {
      address: typeof patch.device.address === "string" ? patch.device.address.trim() : base.device.address,
      name: typeof patch.device.name === "string" ? patch.device.name.trim() : base.device.name,
    };
  }
  if (patch.pricing && typeof patch.pricing === "object") {
    const source = patch.pricing;
    const basePricing = base.pricing || DEFAULT_CONFIG.pricing;
    next.pricing = {
      modelId: typeof source.modelId === "string" ? source.modelId : basePricing.modelId,
      tariff: ["auto", "peak", "off-peak"].includes(source.tariff) ? source.tariff : basePricing.tariff,
      label: typeof source.label === "string" ? source.label.slice(0, 40) : basePricing.label,
      cacheHitPrice: Math.max(0, Number(source.cacheHitPrice) || 0),
      cacheMissPrice: Math.max(0, Number(source.cacheMissPrice) || 0),
      outputPrice: Math.max(0, Number(source.outputPrice) || 0),
      fxRate: Math.min(20, Math.max(1, Number(source.fxRate) || basePricing.fxRate)),
      updatedAt: Number(source.updatedAt) || basePricing.updatedAt,
      profiles: [],
      assignments: [],
    };
    const rawProfiles = Array.isArray(source.profiles) ? source.profiles.slice(0, 20) : basePricing.profiles || [];
    next.pricing.profiles = rawProfiles
      .map((profile, index) => normalizeProfile(profile, index))
      .filter((profile, index, all) => all.findIndex((other) => other.id === profile.id) === index);
    const profileIds = new Set(next.pricing.profiles.map((profile) => profile.id));
    next.pricing.assignments = normalizeAssignments(
      Array.isArray(source.assignments) ? source.assignments : basePricing.assignments || [],
      profileIds
    );
  }
  if (patch.sections && typeof patch.sections === "object") {
    for (const key of Object.keys(next.sections)) {
      if (typeof patch.sections[key] === "boolean") next.sections[key] = patch.sections[key];
    }
  }
  return next;
}

export function loadConfig(configPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return normalizeConfig(raw, DEFAULT_CONFIG);
  } catch {
    return normalizeConfig({}, DEFAULT_CONFIG);
  }
}

export function saveConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, configPath);
  return config;
}

/** 1234567 → "1.2M"; the tag has room for four glyphs, not twelve digits. */
export function formatCompact(value) {
  const n = Number(value) || 0;
  const trim = (scaled, digits) => {
    const text = scaled.toFixed(digits);
    return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  };
  if (n >= 1e9) return `${trim(n / 1e9, n >= 1e10 ? 1 : 2)}B`;
  if (n >= 1e6) return `${trim(n / 1e6, n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${trim(n / 1e3, n >= 1e5 ? 0 : 1)}K`;
  return String(Math.round(n));
}

function clockLabel(now, timeZone) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(5, 16).replace("T", " ");
  }
}

/**
 * Epoch millis of local midnight in ``timeZone`` for the instant ``nowMs``.
 * The ledger's own "today" range is a rolling 24 h window, which keeps showing
 * yesterday's usage right after midnight — the tag wants the calendar day.
 */
export function zonedMidnight(nowMs, timeZone) {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = format.formatToParts(new Date(nowMs));
  const read = (type) => Number(parts.find((part) => part.type === type)?.value);
  const wallClock = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));
  /* Compare whole seconds: carrying the millisecond part into the zone offset
     pushed midnight past the bucket boundary and hid the current hour. */
  const offset = wallClock - Math.floor(nowMs / 1000) * 1000;
  return Date.UTC(read("year"), read("month") - 1, read("day")) - offset;
}

/** "2026-11-01T16" → epoch millis of that UTC hour. */
export function bucketStartMs(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(String(key || ""));
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]));
}

/** "2026-11-01" (UTC day key) → epoch millis of that UTC midnight. */
export function dayStartMs(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * Sum the ledger's hourly buckets that fall into the local calendar day that
 * contains ``nowMs``, so the tag clears at local midnight instead of on a
 * rolling 24 h window.
 */
export function localDaySnapshot(history, { now = Date.now(), timeZone = "Asia/Shanghai" } = {}) {
  const since = zonedMidnight(now, timeZone);
  const perSpark = new Map();
  let cachedReported = false;
  for (const bucket of Array.isArray(history?.hour) ? history.hour : []) {
    const start = bucketStartMs(bucket.t);
    if (!Number.isFinite(start) || start < since || start > now) continue;
    const key = typeof bucket.sparkId === "string" && bucket.sparkId ? bucket.sparkId : "unknown";
    const current = perSpark.get(key) || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheReported: false };
    current.promptTokens += Number(bucket.promptTokens) || 0;
    current.completionTokens += Number(bucket.completionTokens) || 0;
    current.cachedTokens += Number(bucket.cachedTokens) || 0;
    if (bucket.cacheReported) {
      current.cacheReported = true;
      cachedReported = true;
    }
    perSpark.set(key, current);
  }
  return {
    range: "today-local",
    since,
    cacheReported: cachedReported,
    series: [...perSpark.entries()].map(([sparkId, totals]) => ({ sparkId, port: 0, totals })),
  };
}

/**
 * Sum daily buckets at or after ``sinceMs``; used for week/month windows where
 * hour-level precision is not needed and hourly retention may be too short.
 */
export function bucketTotalsSince(history, sinceMs, { now = Date.now() } = {}) {
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  for (const bucket of Array.isArray(history?.day) ? history.day : []) {
    const start = dayStartMs(bucket.t);
    if (!Number.isFinite(start) || start < sinceMs - 24 * 3600_000 || start > now) continue;
    promptTokens += Number(bucket.promptTokens) || 0;
    completionTokens += Number(bucket.completionTokens) || 0;
    cachedTokens += Number(bucket.cachedTokens) || 0;
  }
  return { promptTokens, completionTokens, cachedTokens };
}

/** Wrap an aggregate total as a one-series snapshot so the pricer can run on it. */
function priceWindowSnapshot(totals) {
  return {
    series: [
      {
        sparkId: "unknown",
        port: 0,
        totals,
        models: [{ modelId: "", ...totals }],
      },
    ],
  };
}

/**
 * Hourly ledger rows for the requested cost window.
 *
 * Cost has to be charged per hour, because the official table is time-of-day
 * dependent; the aggregates these ranges used to be priced from have no hour
 * dimension left. Hourly buckets are retained for 35 days, which covers every
 * range the page offers.
 *
 * @param {string} range one of today / 24h / week / month / all
 * @param {{hour?: Array<object>}} history ledger history
 * @param {{ now?: number, timeZone?: string }} [options]
 */
export function costRowsForRange(range, history, { now = Date.now(), timeZone = "Asia/Shanghai" } = {}) {
  const rows = Array.isArray(history?.hour) ? history.hour : [];
  if (range === "all") return rows;
  let since;
  if (range === "today") {
    since = zonedMidnight(now, timeZone);
  } else if (range === "24h") {
    since = now - 24 * 3600_000;
  } else if (range === "week" || range === "month") {
    const midnight = zonedMidnight(now, timeZone);
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, weekday: "short", day: "2-digit" }).formatToParts(new Date(now));
    const dayOfMonth = Number(parts.find((part) => part.type === "day")?.value) || 1;
    since = range === "month" ? midnight - (dayOfMonth - 1) * 24 * 3600_000 : midnight - 6 * 24 * 3600_000;
  } else {
    return rows;
  }
  return rows.filter((row) => {
    const start = bucketStartMs(row?.t);
    return Number.isFinite(start) && start >= since && start <= now;
  });
}

/**
 * The published rates for one tariff of the configured model, or null when the
 * model has a single price (hosted/manual entries).
 */
export function peakOffPeakRates(pricing, tariff) {
  const official = findOfficialModel(pricing?.modelId);
  if (!official) return null;
  const key = tariff === "peak" ? "peak" : "offPeak";
  return {
    cacheHit: official.cacheHit[key],
    cacheMiss: official.cacheMiss[key],
    output: official.output[key],
  };
}

/** How many hours of the window fell inside the peak (double-price) tariff. */
export function countPeakHours(rows) {
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const at = hourKeyToDate(row?.t);
    if (at && isPeakHour(at)) seen.add(row.t);
  }
  return seen.size;
}

/**
 * Build the scene the bridge renders. Only aggregate numbers leave this function —
 * the tag shows a summary, never per-model detail.
 *
 * @param {object} args
 * @param {{series?: Array<object>}} args.snapshot token ledger snapshot for the requested range
 * @param {object} args.config normalized e-ink configuration
 * @param {number} [args.now] epoch millis, injectable for tests
 * @param {string} [args.timeZone]
 */
export function buildScene({ snapshot, config, now = Date.now(), timeZone = "Asia/Shanghai", costRows = null }) {
  const series = Array.isArray(snapshot?.series) ? snapshot.series : [];
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let cacheReported = false;
  const perSpark = new Map();

  for (const item of series) {
    const totals = item?.totals || {};
    const prompt = Number(totals.promptTokens) || 0;
    const completion = Number(totals.completionTokens) || 0;
    const cached = Number(totals.cachedTokens) || 0;
    promptTokens += prompt;
    completionTokens += completion;
    cachedTokens += cached;
    if (totals.cacheReported) cacheReported = true;
    const sparkId = typeof item?.sparkId === "string" && item.sparkId ? item.sparkId : "unknown";
    const current = perSpark.get(sparkId) || 0;
    perSpark.set(sparkId, current + prompt + completion);
  }

  const total = promptTokens + completionTokens;
  const rows = [...perSpark.entries()]
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const rowMax = rows.length ? rows[0][1] : 0;

  const stats = [];
  if (cacheReported && promptTokens > 0) {
    stats.push({ label: "缓存", value: `${Math.round((cachedTokens / promptTokens) * 100)}%` });
  }
  stats.push({ label: "输入", value: formatCompact(promptTokens) });
  stats.push({ label: "输出", value: formatCompact(completionTokens) });

  const priced = priceSnapshot({ series, pricing: config.pricing, now: new Date(now) });
  const stamp = clockLabel(now, timeZone);
  const footer = config.footer ? config.footer.replace(/\{time\}/gi, stamp) : `每 ${config.intervalMinutes} 分钟刷新`;
  // Charge each hour at the tariff that applied to it, under the price book of the
  // endpoint that burned it. The per-endpoint snapshot above has no hour dimension
  // left, so it is only the fallback when the ledger cannot supply hourly rows.
  const rates = resolveRates(config.pricing, { now: new Date(now) });
  const costBuckets = Array.isArray(costRows) ? costRows : [];
  const hourlyCost = costBuckets.length ? computeCostByHour(costBuckets, config.pricing) : null;
  const costValue = hourlyCost == null ? priced.formatted : formatCny(hourlyCost);

  const scene = {
    title: config.title || "sparkDash",
    subtitle: stamp,
    headline: { label: "今日 Token", value: formatCompact(total) },
    stats: config.sections.stats ? stats.slice(0, 3) : [],
    rows: config.sections.rows
      ? rows.map(([label, value]) => {
          /* Each node carries its own price book, so the row shows what that
             node's traffic would cost — the tag never invents a fleet average.
             When hourly rows exist the node figure is charged hour by hour too,
             so the rows add up to the headline instead of drifting from it. */
          const own = priced.groups.filter((group) => group.sparkId === label);
          const ownHours = costBuckets.filter((row) => (row.sparkId || "unknown") === label);
          const rowCost = ownHours.length
            ? computeCostByHour(ownHours, config.pricing)
            : own.reduce((sum, group) => sum + group.cost, 0);
          const showCost = (own.length || ownHours.length) && config.sections.cost;
          return {
            label,
            value: formatCompact(value),
            ratio: rowMax ? value / rowMax : 0,
            cost: showCost ? formatCny(rowCost) : "",
          };
        })
      : [],
    footer,
    pigment: config.pigment,
    theme: config.theme,
    backgroundDim: config.backgroundDim,
    textProtection: config.textProtection,
    haloWidth: config.haloWidth,
    backgroundZoom: config.backgroundZoom,
    backgroundOffsetX: config.backgroundOffsetX,
    backgroundOffsetY: config.backgroundOffsetY,
    backgroundBrightness: config.backgroundBrightness,
    backgroundContrast: config.backgroundContrast,
    ditherAlgorithm: config.ditherAlgorithm,
    ditherStrength: config.ditherStrength,
    cost: config.sections.cost ? { label: "云价", value: costValue, tariff: rates.tariff, source: rates.source } : null,
  };
  if (!config.sections.headline) scene.headline = { label: "今日 Token", value: formatCompact(total) };
  return scene;
}

function hostBackgroundPath(config, configHostDir) {
  if (!config.background || !config.background.name) return null;
  if (!configHostDir) return null;
  return path.join(configHostDir, "eink-assets", config.background.name);
}

/**
 * Register the e-ink routes and own the refresh timer.
 *
 * @param {object} args
 * @param {import("express").Express} args.app
 * @param {(range: string) => object} args.ledgerSnapshot
 * @param {string} args.configPath container path of eink.json
 * @param {string} [args.configHostDir] host path of the config directory (bridge reads files there)
 * @param {string} [args.bridgeUrl]
 * @param {() => number} [args.now]
 */
export function createEinkRuntime({
  app,
  ledgerSnapshot,
  ledgerHistory = null,
  configPath = path.join(ROOT, "config", "eink.json"),
  configHostDir = process.env.EINK_CONFIG_HOST_DIR || null,
  bridgeUrl = process.env.EINK_BRIDGE_URL || "http://127.0.0.1:8790",
  now = Date.now,
  fetchImpl = (...args) => fetch(...args),
  log = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  timeZone = process.env.TZ || "Asia/Shanghai",
}) {
  let config = loadConfig(configPath);
  let timer = null;
  let busy = false;
  let lastAttemptAt = 0;
  let lastOkAt = 0;
  let lastError = null;
  let batteryMv = null;
  let batteryPercent = null;
  let lastDurationMs = null;

  const assetsDir = path.join(path.dirname(configPath), "eink-assets");

  const status = () => ({
    enabled: config.enabled,
    batteryPercent,
    device: config.device,
    intervalMinutes: config.intervalMinutes,
    nextRunAt:
      config.enabled && lastAttemptAt ? lastAttemptAt + config.intervalMinutes * 60_000 : null,
    lastAttemptAt: lastAttemptAt || null,
    lastOkAt: lastOkAt || null,
    lastError,
    batteryMv,
    lastDurationMs,
    bridgeUrl,
  });

  function tokensForToday() {
    if (ledgerHistory) {
      try {
        return localDaySnapshot(ledgerHistory(), { now: now(), timeZone });
      } catch {
        /* fall through to the rolling window */
      }
    }
    return ledgerSnapshot("today");
  }

  function sceneFromLedger() {
    return buildScene({
      snapshot: tokensForToday(),
      config,
      now: now(),
      timeZone,
      costRows: ledgerHistory ? costRowsForRange("today", ledgerHistory(), { now: now(), timeZone }) : null,
    });
  }

  async function callBridge(pathname, body, { timeoutMs = BRIDGE_TIMEOUT_MS, raw = false } = {}) {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${bridgeUrl}${pathname}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = `bridge HTTP ${res.status}`;
        try {
          const payload = await res.json();
          if (payload?.error) detail = payload.error;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(detail);
      }
      return raw ? Buffer.from(await res.arrayBuffer()) : await res.json();
    } catch (err) {
      if (err?.name === "AbortError") throw new Error(`bridge timeout after ${Math.round(timeoutMs / 1000)}s`);
      throw err;
    } finally {
      clearTimeout(timerId);
    }
  }

  async function display(reason = "manual") {
    if (busy) throw new Error("上一次刷新还没结束");
    if (!config.device.address && !config.device.name) throw new Error("还没有选择墨水屏设备");
    busy = true;
    const startedAt = now();
    lastAttemptAt = startedAt;
    try {
      const scene = sceneFromLedger();
      /* Battery comes from the previous connection: the tag cannot report it
         before we have written the frame it would appear in. */
      if (batteryPercent != null) scene.battery = { percent: batteryPercent };
      const background = hostBackgroundPath(config, configHostDir);
      if (background) scene.background = background;
      const result = await callBridge("/display", { scene, device: config.device });
      lastOkAt = now();
      lastDurationMs = lastOkAt - startedAt;
      lastError = null;
      if (typeof result?.batteryMv === "number") batteryMv = result.batteryMv;
      if (typeof result?.batteryPercent === "number") batteryPercent = result.batteryPercent;
      log.log(`[eink] ${reason} refresh ok in ${lastDurationMs} ms`);
      return { scene, result, durationMs: lastDurationMs };
    } catch (err) {
      lastError = err?.message || String(err);
      lastDurationMs = now() - startedAt;
      log.error(`[eink] ${reason} refresh failed: ${lastError}`);
      throw err;
    } finally {
      busy = false;
    }
  }

  const tick = () => {
    if (!config.enabled || busy) return;
    // After a failure, try again sooner than the full interval: a tag that was
    // asleep or holding a stale link recovers long before the next slot.
    const waitMs = lastError
      ? Math.min(config.intervalMinutes * 60_000, RETRY_AFTER_ERROR_MS)
      : config.intervalMinutes * 60_000;
    if (now() - lastAttemptAt < waitMs) return;
    display("schedule").catch(() => {
      /* already recorded in lastError */
    });
  };

  /* ── routes (registered after the auth middleware in index.js) ─────────── */

  app.get("/api/eink/config", (_req, res) => res.json({ config, status: status() }));

  app.put("/api/eink/config", (req, res) => {
    const next = normalizeConfig(req.body || {}, config);
    config = saveConfig(configPath, next);
    res.json({ config, status: status() });
  });

  app.get("/api/eink/status", (_req, res) => res.json(status()));

  /* Same rates as the tag, exposed for the Tokens page so both surfaces agree. */
  app.get("/api/llm-token-cost", (req, res) => {
    const range = typeof req.query?.range === "string" && req.query.range ? req.query.range : "today";
    try {
      let snapshot;
      if (range === "today" && ledgerHistory) {
        snapshot = localDaySnapshot(ledgerHistory(), { now: now(), timeZone });
      } else if ((range === "week" || range === "month") && ledgerHistory) {
        const history = ledgerHistory();
        const midnight = zonedMidnight(now(), timeZone);
        const parts = new Intl.DateTimeFormat("en-CA", { timeZone, weekday: "short", day: "2-digit" }).formatToParts(new Date(now()));
        const dayOfMonth = Number(parts.find((part) => part.type === "day")?.value) || 1;
        const since = range === "month" ? midnight - (dayOfMonth - 1) * 24 * 3600_000 : midnight - 6 * 24 * 3600_000;
        snapshot = priceWindowSnapshot(bucketTotalsSince(history, since, { now: now() }));
      } else {
        snapshot = ledgerSnapshot(range === "24h" ? "today" : range);
      }
      const priced = priceSnapshot({ series: snapshot?.series, pricing: config.pricing, now: new Date(now()) });
      let promptTokens = 0;
      let completionTokens = 0;
      let cachedTokens = 0;
      for (const group of priced.groups) {
        promptTokens += group.tokens.promptTokens;
        completionTokens += group.tokens.completionTokens;
        cachedTokens += group.tokens.cachedTokens;
      }
      // Charge every hour at its own tariff, under the price book of the endpoint
      // that burned it. The official table doubles at peak, so pricing the whole
      // window at the tariff that happens to be live now would misprice the rest by
      // up to 2x. The per-endpoint snapshot — already split by price book, but with
      // no hour dimension — is the fallback when the ledger has no hourly rows.
      const hourRows = ledgerHistory ? costRowsForRange(range, ledgerHistory(), { now: now(), timeZone }) : [];
      const cost = hourRows.length ? computeCostByHour(hourRows, config.pricing) : priced.total;
      // The rates line describes the tariff live right now; `peakHours` says how
      // much of the window was actually charged at peak.
      const rates = resolveRates(config.pricing, { now: new Date(now()) });
      res.json({
        range,
        currency: "CNY",
        cost,
        formatted: formatCny(cost),
        tokens: { promptTokens, completionTokens, cachedTokens, total: promptTokens + completionTokens },
        modelId: config.pricing.modelId,
        label: rates.label,
        tariff: rates.tariff,
        // The configured mode ("auto" prices every hour at its own tariff); `tariff`
        // above is only the one live right now.
        tariffMode: config.pricing.tariff,
        source: rates.source,
        peakHours: countPeakHours(hourRows),
        rates: { cacheHit: rates.cacheHit, cacheMiss: rates.cacheMiss, output: rates.output },
        // Both tariffs, when the model publishes them: an hourly estimate is a mix,
        // so quoting only the live one would misstate what was charged.
        peakRates: peakOffPeakRates(config.pricing, "peak"),
        offPeakRates: peakOffPeakRates(config.pricing, "off-peak"),
        pricingUpdatedAt: config.pricing.updatedAt,
        profiles: config.pricing.profiles,
        assignments: config.pricing.assignments,
        groups: priced.groups.map((group) => ({
          ...group,
          key: `${group.sparkId}:${group.port}${group.modelId ? `:${group.modelId}` : ""}`,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get("/api/eink/pricing", (_req, res) =>
    res.json({ models: listPriceModels(), pricing: config.pricing, source: OFFICIAL_SOURCE })
  );

  app.post("/api/eink/pricing/refresh", async (_req, res) => {
    try {
      const response = await fetchImpl(OFFICIAL_SOURCE, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`官网返回 HTTP ${response.status}`);
      const html = await response.text();
      const parsed = parseOfficialPricing(html);
      if (!applyOfficialPricing(parsed)) throw new Error("没在官网页面里找到价格表");
      config = saveConfig(configPath, normalizeConfig({ pricing: { updatedAt: now() } }, config));
      res.json({ ok: true, models: listPriceModels(), pricing: config.pricing });
    } catch (err) {
      res.status(502).json({ ok: false, error: err?.message || String(err), models: listPriceModels() });
    }
  });

  app.get("/api/eink/algorithms", async (_req, res) => {
    try {
      const payload = await callBridge("/algorithms");
      res.json({ algorithms: Array.isArray(payload?.algorithms) ? payload.algorithms : DITHER_ALGORITHMS });
    } catch {
      res.json({ algorithms: DITHER_ALGORITHMS });
    }
  });

  app.get("/api/eink/devices", async (req, res) => {
    try {
      const all = req.query?.all === "1" ? "?all=1" : "";
      const payload = await callBridge(`/devices${all}`);
      res.json(payload);
    } catch (err) {
      res.status(502).json({ ok: false, error: err?.message || String(err), devices: [] });
    }
  });

  app.post("/api/eink/preview", async (req, res) => {
    try {
      // The preview must show the form being edited, not the last saved config.
      const effective = normalizeConfig(req.body?.config || {}, config);
      const scene = buildScene({
        snapshot: tokensForToday(),
        config: effective,
        now: now(),
        timeZone,
        costRows: ledgerHistory ? costRowsForRange("today", ledgerHistory(), { now: now(), timeZone }) : null,
      });
      const background = hostBackgroundPath(effective, configHostDir);
      if (background) scene.background = background;
      const png = await callBridge("/render", { scene }, { raw: true, timeoutMs: 30_000 });
      res.set("Cache-Control", "no-store").type("png").send(png);
    } catch (err) {
      res.status(502).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post("/api/eink/display", async (_req, res) => {
    try {
      const outcome = await display("manual");
      res.json({ ok: true, ...outcome, status: status() });
    } catch (err) {
      res.status(502).json({ ok: false, error: err?.message || String(err), status: status() });
    }
  });

  app.post("/api/eink/background", (req, res) => {
    try {
      const dataUrl = typeof req.body?.dataUrl === "string" ? req.body.dataUrl : "";
      const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg));base64,(.+)$/);
      if (!match) return res.status(400).json({ error: "只支持 PNG/JPEG 图片" });
      const buf = Buffer.from(match[2], "base64");
      if (buf.length > MAX_BACKGROUND_BYTES) return res.status(400).json({ error: "图片太大了（上限 4 MB）" });
      fs.mkdirSync(assetsDir, { recursive: true });
      const ext = match[1] === "image/png" ? "png" : "jpg";
      const name = `bg-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(assetsDir, name), buf);
      config = saveConfig(configPath, normalizeConfig({ background: { name } }, config));
      res.json({ config, status: status() });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.delete("/api/eink/background", (_req, res) => {
    config = saveConfig(configPath, normalizeConfig({ background: null }, config));
    res.json({ config, status: status() });
  });

  return {
    start() {
      if (timer) return false;
      timer = setIntervalFn(tick, TICK_MS);
      if (typeof timer?.unref === "function") timer.unref();
      return true;
    },
    stop() {
      if (!timer) return false;
      clearIntervalFn(timer);
      timer = null;
      return true;
    },
    status,
    display,
    getConfig: () => config,
    configPath,
    assetsDir,
  };
}