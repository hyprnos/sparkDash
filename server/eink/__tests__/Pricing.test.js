import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeCost,
  computeCostByHour,
  formatCny,
  hourKeyToDate,
  isPeakHour,
  parseOfficialPricing,
  resolveRates,
} from "../Pricing.js";

test("peak windows follow the published Beijing-time schedule", () => {
  const beijing = (iso) => new Date(iso);
  /* 2026-11-02 is a Monday. 10:00 Beijing = 02:00Z. */
  assert.equal(isPeakHour(beijing("2026-11-02T02:00:00Z")), true);
  assert.equal(isPeakHour(beijing("2026-11-02T05:00:00Z")), false, "13:00 Beijing is between windows");
  assert.equal(isPeakHour(beijing("2026-11-02T07:00:00Z")), true, "15:00 Beijing is inside the second window");
  assert.equal(isPeakHour(beijing("2026-11-07T02:00:00Z")), false, "Saturday is off-peak");
});

test("official presets price cache hits, misses and output separately", () => {
  const rates = resolveRates({ modelId: "deepseek-flash", tariff: "off-peak" });
  assert.equal(rates.cacheMiss, 1);
  assert.equal(rates.cacheHit, 0.02);
  assert.equal(rates.output, 4);
  const cost = computeCost({ promptTokens: 2_000_000, cachedTokens: 1_500_000, completionTokens: 100_000 }, rates);
  /* (0.5M × 1 + 1.5M × 0.02 + 0.1M × 4) / 1M = 0.5 + 0.03 + 0.4 */
  assert.ok(Math.abs(cost - 0.93) < 1e-9, `unexpected cost ${cost}`);
});

test("manual pricing is used when the model is not an official preset", () => {
  const rates = resolveRates(
    { modelId: "custom", tariff: "peak", cacheMissPrice: 10, cacheHitPrice: 1, outputPrice: 20 },
    { now: new Date("2026-11-02T02:00:00Z") }
  );
  assert.equal(rates.source, "manual");
  assert.equal(rates.cacheMiss, 10);
  assert.ok(Math.abs(computeCost({ promptTokens: 1_000_000, completionTokens: 1_000_000 }, rates) - 30) < 1e-9, "10 + 20");
});

test("formatCny keeps the tag glyph count small", () => {
  assert.equal(formatCny(0), "¥0");
  assert.equal(formatCny(0.42), "¥0.42");
  assert.equal(formatCny(12.34), "¥12.3");
  assert.equal(formatCny(1234.5), "¥1235");
});

test("the official price table parser reads the published numbers", () => {
  const html = [
    "价格 百万tokens输入 缓存命中 空闲时段 0.02元 0.15元 高峰时段 0.04元 0.30元",
    "百万tokens输入 缓存未命中 空闲时段 1元 4.5元 高峰时段 2元 9.0元",
    "百万tokens输出 空闲时段 4元 13.5元 高峰时段 8元 27.0元 并发限制 2500 500",
  ].join(" ");
  const parsed = parseOfficialPricing(html);
  assert.ok(parsed);
  assert.equal(parsed.flash.hit, 0.02);
  assert.equal(parsed.flash.miss, 1);
  assert.equal(parsed.flash.output, 4);
  assert.equal(parsed.pro.hit, 0.15);
  assert.equal(parsed.pro.miss, 4.5);
  assert.equal(parsed.pro.output, 13.5);
  assert.equal(parseOfficialPricing("<html><body>nothing here</body></html>"), null);
});

test("hour buckets map to the instant that hour starts (UTC keys)", () => {
  assert.equal(hourKeyToDate("2026-11-02T02").toISOString(), "2026-11-02T02:00:00.000Z");
  assert.equal(hourKeyToDate("2026-11-02"), null, "a day key is not an hour");
  assert.equal(hourKeyToDate(""), null);
  assert.equal(hourKeyToDate(null), null);
});

test("each hour is charged at its own tariff, not at whatever is live now", () => {
  // 2026-11-02 is a Monday. 02:00Z = 10:00 Beijing (peak); 05:00Z = 13:00
  // Beijing (between windows, off-peak).
  const rows = [
    { t: "2026-11-02T02", promptTokens: 1_000_000 },
    { t: "2026-11-02T05", promptTokens: 1_000_000 },
  ];
  const pricing = { modelId: "deepseek-flash", tariff: "auto" };
  // deepseek-flash cache-miss is 2/M at peak and 1/M off-peak.
  const cost = computeCostByHour(rows, pricing);
  const peakOnly = computeCost({ promptTokens: 2_000_000 }, resolveRates(pricing, { now: hourKeyToDate("2026-11-02T02") }));
  const offPeakOnly = computeCost({ promptTokens: 2_000_000 }, resolveRates(pricing, { now: hourKeyToDate("2026-11-02T05") }));
  assert.ok(Math.abs(cost - 3) < 1e-9, `2 (peak) + 1 (off-peak), got ${cost}`);
  // The old single-tariff behaviour would have produced 2 or 4 instead.
  assert.notEqual(Math.round(peakOnly * 100) / 100, 3);
  assert.notEqual(Math.round(offPeakOnly * 100) / 100, 3);
});

test("a pinned tariff charges every hour the same, matching the flat total", () => {
  const rows = [
    { t: "2026-11-02T02", promptTokens: 1_000_000, completionTokens: 100_000 },
    { t: "2026-11-02T05", promptTokens: 1_000_000, completionTokens: 100_000 },
  ];
  for (const tariff of ["peak", "off-peak"]) {
    const pricing = { modelId: "deepseek-flash", tariff };
    const byHour = computeCostByHour(rows, pricing);
    const flat = computeCost(
      { promptTokens: 2_000_000, completionTokens: 200_000 },
      resolveRates(pricing)
    );
    assert.ok(Math.abs(byHour - flat) < 1e-9, `${tariff}: ${byHour} vs ${flat}`);
  }
});

test("hours of one bucket are summed before pricing, and junk rows are ignored", () => {
  const rows = [
    { t: "2026-11-02T05", promptTokens: 500_000 },
    { t: "2026-11-02T05", promptTokens: 500_000 },
    { t: "nonsense", promptTokens: 999_999 },
    { promptTokens: 999_999 },
  ];
  const cost = computeCostByHour(rows, { modelId: "deepseek-flash", tariff: "off-peak" });
  assert.ok(Math.abs(cost - 1) < 1e-9, `one off-peak million, got ${cost}`);
  assert.equal(computeCostByHour([], { modelId: "deepseek-flash" }), 0);
  assert.equal(computeCostByHour(null, { modelId: "deepseek-flash" }), 0);
});

test("each hour is priced under the price book of the endpoint that burned it", () => {
  // The hourly ledger rows carry sparkId/port/modelId, so per-endpoint profiles
  // and per-hour tariffs have to hold at the same time: a fleet average would
  // charge the Pro endpoint's tokens at the Flash rate.
  const pricing = {
    modelId: "deepseek-flash",
    tariff: "auto",
    profiles: [{ id: "pro", name: "V4 Pro book", modelId: "deepseek-v4-pro", tariff: "auto" }],
    assignments: [{ sparkId: "spark002", port: 0, modelId: "", profileId: "pro" }],
  };
  const rows = [
    // 02:00Z is 10:00 Beijing (peak): flash miss 2/M, pro miss 9/M.
    { t: "2026-11-02T02", sparkId: "spark001", port: 8888, modelId: "DeepSeek-V4.1-Flash-1017", promptTokens: 1_000_000 },
    { t: "2026-11-02T02", sparkId: "spark002", port: 8888, modelId: "DeepSeek-V4-Pro-0813", promptTokens: 1_000_000 },
    // 05:00Z is 13:00 Beijing (off-peak): pro miss 4.5/M.
    { t: "2026-11-02T05", sparkId: "spark002", port: 8888, modelId: "DeepSeek-V4-Pro-0813", promptTokens: 1_000_000 },
  ];
  const cost = computeCostByHour(rows, pricing);
  assert.ok(Math.abs(cost - 15.5) < 1e-9, `2 + 9 + 4.5, got ${cost}`);
  // One price book for the whole window would have said 5 (all flash) instead.
  assert.ok(Math.abs(computeCostByHour(rows, { modelId: "deepseek-flash", tariff: "auto" }) - 5) < 1e-9);
});
