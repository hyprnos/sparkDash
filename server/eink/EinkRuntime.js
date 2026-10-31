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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

/** Sensor floor for a refresh: colour e-paper needs ~20 s per update and runs on a battery. */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 1440;
const MAX_BACKGROUND_BYTES = 4 * 1024 * 1024;
const TICK_MS = 60_000;
const RETRY_AFTER_ERROR_MS = 5 * 60_000;
const BRIDGE_TIMEOUT_MS = 120_000;

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  device: { address: "", name: "NRF_EPD_A568" },
  intervalMinutes: 30,
  pigment: "yellow",
  theme: "dark",
  sections: { headline: true, stats: true, rows: true },
  background: null,
  backgroundDim: 0.35,
  /** Drawn as the tag's top line; empty falls back to "sparkDash". */
  title: "sparkDash",
  /** Footer override; "{time}" expands to the render time. Empty keeps the interval note. */
  footer: "",
  /** "scrim" | "plate" | "off" — how text is kept readable over a background photo. */
  textProtection: "scrim",
});

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
    background: patch.background === undefined ? base.background : normalizeBackground(patch.background),
    backgroundDim:
      patch.backgroundDim === undefined
        ? base.backgroundDim
        : Math.min(0.9, Math.max(0, Number(patch.backgroundDim) || 0)),
    title:
      patch.title === undefined ? base.title : String(patch.title).trim().slice(0, 24),
    footer:
      patch.footer === undefined ? base.footer : String(patch.footer).trim().slice(0, 48),
    textProtection: ["scrim", "plate", "off"].includes(patch.textProtection)
      ? patch.textProtection
      : base.textProtection,
  };
  if (patch.device && typeof patch.device === "object") {
    next.device = {
      address: typeof patch.device.address === "string" ? patch.device.address.trim() : base.device.address,
      name: typeof patch.device.name === "string" ? patch.device.name.trim() : base.device.name,
    };
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
 * Build the scene the bridge renders. Only aggregate numbers leave this function —
 * the tag shows a summary, never per-model detail.
 *
 * @param {object} args
 * @param {{series?: Array<object>}} args.snapshot token ledger snapshot for the requested range
 * @param {object} args.config normalized e-ink configuration
 * @param {number} [args.now] epoch millis, injectable for tests
 * @param {string} [args.timeZone]
 */
export function buildScene({ snapshot, config, now = Date.now(), timeZone = "Asia/Shanghai" }) {
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

  const stamp = clockLabel(now, timeZone);
  const footer = config.footer ? config.footer.replace(/\{time\}/gi, stamp) : `每 ${config.intervalMinutes} 分钟刷新`;
  const scene = {
    title: config.title || "sparkDash",
    subtitle: stamp,
    headline: { label: "今日 Token", value: formatCompact(total) },
    stats: config.sections.stats ? stats.slice(0, 3) : [],
    rows: config.sections.rows
      ? rows.map(([label, value]) => ({ label, value: formatCompact(value), ratio: rowMax ? value / rowMax : 0 }))
      : [],
    footer,
    pigment: config.pigment,
    theme: config.theme,
    backgroundDim: config.backgroundDim,
    textProtection: config.textProtection,
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
  let lastDurationMs = null;

  const assetsDir = path.join(path.dirname(configPath), "eink-assets");

  const status = () => ({
    enabled: config.enabled,
    device: config.device,
    intervalMinutes: config.intervalMinutes,
    nextRunAt: config.enabled ? lastAttemptAt + config.intervalMinutes * 60_000 : null,
    lastAttemptAt: lastAttemptAt || null,
    lastOkAt: lastOkAt || null,
    lastError,
    batteryMv,
    lastDurationMs,
    bridgeUrl,
  });

  function sceneFromLedger() {
    return buildScene({ snapshot: ledgerSnapshot("today"), config, now: now(), timeZone });
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
      const background = hostBackgroundPath(config, configHostDir);
      if (background) scene.background = background;
      const result = await callBridge("/display", { scene, device: config.device });
      lastOkAt = now();
      lastDurationMs = lastOkAt - startedAt;
      lastError = null;
      if (typeof result?.batteryMv === "number") batteryMv = result.batteryMv;
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
        snapshot: ledgerSnapshot("today"),
        config: effective,
        now: now(),
        timeZone,
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