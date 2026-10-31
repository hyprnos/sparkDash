import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DEFAULT_CONFIG,
  buildScene,
  formatCompact,
  loadConfig,
  normalizeConfig,
  saveConfig,
} from "../EinkRuntime.js";

const SNAPSHOT = {
  range: "today",
  series: [
    {
      sparkId: "spark001",
      port: 8888,
      totals: { promptTokens: 2_000_000, completionTokens: 500_000, cachedTokens: 400_000, cacheReported: true },
    },
    {
      sparkId: "spark002",
      port: 8888,
      totals: { promptTokens: 400_000, completionTokens: 100_000, cachedTokens: 0, cacheReported: false },
    },
  ],
};

test("buildScene aggregates today's tokens into a compact scene", () => {
  const scene = buildScene({
    snapshot: SNAPSHOT,
    config: { ...DEFAULT_CONFIG, intervalMinutes: 30 },
    now: Date.UTC(2026, 10, 1, 0, 30),
  });

  assert.equal(scene.headline.label, "今日 Token");
  assert.equal(scene.headline.value, "3M");
  assert.deepEqual(
    scene.stats.map((s) => s.label),
    ["缓存", "输入", "输出"]
  );
  assert.equal(scene.stats[1].value, "2.4M");
  assert.deepEqual(scene.rows.map((r) => r.label), ["spark001", "spark002"]);
  assert.equal(scene.rows[0].ratio, 1);
  assert.ok(scene.rows[1].ratio < 1);
  assert.equal(scene.footer, "每 30 分钟刷新");
  assert.equal(scene.pigment, "yellow");
});

test("buildScene honours the section toggles", () => {
  const scene = buildScene({
    snapshot: SNAPSHOT,
    config: { ...DEFAULT_CONFIG, sections: { headline: true, stats: false, rows: false } },
    now: 0,
  });
  assert.deepEqual(scene.stats, []);
  assert.deepEqual(scene.rows, []);
});

test("normalizeConfig clamps the interval and drops unknown pigment values", () => {
  assert.equal(normalizeConfig({ intervalMinutes: 1 }).intervalMinutes, 5);
  assert.equal(normalizeConfig({ intervalMinutes: 99_999 }).intervalMinutes, 1440);
  assert.equal(normalizeConfig({ pigment: "purple" }).pigment, DEFAULT_CONFIG.pigment);
  assert.equal(normalizeConfig({ background: { name: "../evil.png" } }).background.name, "evil.png");
  assert.deepEqual(normalizeConfig({ sections: { rows: false } }).sections, {
    headline: true,
    stats: true,
    rows: false,
  });
});

test("config round-trips through disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eink-config-"));
  const file = path.join(dir, "eink.json");
  const saved = saveConfig(file, normalizeConfig({ enabled: true, intervalMinutes: 60 }));
  assert.deepEqual(loadConfig(file), saved);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("formatCompact keeps the number short enough for the panel", () => {
  assert.equal(formatCompact(999), "999");
  assert.equal(formatCompact(12_345), "12.3K");
  assert.equal(formatCompact(4_500_000), "4.5M");
  assert.equal(formatCompact(2_400_000_000), "2.4B");
});