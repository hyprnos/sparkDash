import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeCost,
  formatCny,
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
