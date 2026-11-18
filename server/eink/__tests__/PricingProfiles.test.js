import test from "node:test";
import assert from "node:assert/strict";
import { matchProfile, priceSnapshot } from "../Pricing.js";

const pricing = {
  modelId: "deepseek-flash",
  tariff: "off-peak",
  cacheHitPrice: 0,
  cacheMissPrice: 0,
  outputPrice: 0,
  fxRate: 7.2,
  profiles: [
    {
      id: "pro",
      name: "V4 Pro book",
      modelId: "deepseek-v4-pro",
      tariff: "off-peak",
      cacheHitPrice: 0,
      cacheMissPrice: 0,
      outputPrice: 0,
      fxRate: 7.2,
    },
    {
      id: "claude",
      name: "Claude book",
      modelId: "claude-sonnet",
      tariff: "off-peak",
      cacheHitPrice: 0,
      cacheMissPrice: 0,
      outputPrice: 0,
      fxRate: 7.2,
    },
  ],
  assignments: [
    { sparkId: "spark002", port: 0, modelId: "", profileId: "pro" },
    { sparkId: "spark002", port: 8888, modelId: "", profileId: "claude" },
    { sparkId: "spark002", port: 8888, modelId: "DeepSeek-V4.1-Flash-1017", profileId: "pro" },
  ],
};

test("an endpoint-specific rule beats the spark-wide rule", () => {
  const match = matchProfile(pricing, { sparkId: "spark002", port: 8888, modelId: "other-model" });
  assert.equal(match.profileId, "claude");
  assert.equal(match.matched, true);
});

test("a model-specific rule beats the endpoint rule", () => {
  const match = matchProfile(pricing, { sparkId: "spark002", port: 8888, modelId: "DeepSeek-V4.1-Flash-1017" });
  assert.equal(match.profileId, "pro");
});

test("an unassigned endpoint falls back to the default book", () => {
  const match = matchProfile(pricing, { sparkId: "spark001", port: 8888, modelId: "x" });
  assert.equal(match.profileId, "default");
  assert.equal(match.matched, false);
});

test("an assignment pointing at a missing profile is ignored", () => {
  const broken = { ...pricing, assignments: [{ sparkId: "spark003", port: 0, modelId: "", profileId: "gone" }] };
  assert.equal(matchProfile(broken, { sparkId: "spark003", port: 0, modelId: "" }).profileId, "default");
});

test("priceSnapshot prices each endpoint with its own book and totals them", () => {
  const series = [
    {
      sparkId: "spark001",
      port: 8888,
      models: [{ modelId: "DeepSeek-V4.1-Flash-1017", promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 0 }],
    },
    {
      sparkId: "spark002",
      port: 8888,
      models: [{ modelId: "DeepSeek-V4.1-Flash-1017", promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 0 }],
    },
  ];
  const priced = priceSnapshot({ series, pricing, now: new Date("2026-11-02T20:00:00Z") });
  assert.equal(priced.groups.length, 2);
  const flash = priced.groups.find((group) => group.sparkId === "spark001");
  const pro = priced.groups.find((group) => group.sparkId === "spark002");
  /* 1M uncached prompt tokens: flash 1 CNY, V4 Pro 4.5 CNY, both off-peak. */
  assert.equal(Math.round(flash.cost * 100) / 100, 1);
  assert.equal(Math.round(pro.cost * 100) / 100, 4.5);
  assert.equal(pro.profileId, "pro");
  assert.equal(Math.round(priced.total * 100) / 100, 5.5);
});

test("endpoints with no traffic are skipped", () => {
  const series = [{ sparkId: "spark003", port: 8888, models: [{ modelId: "m", promptTokens: 0, completionTokens: 0 }] }];
  assert.deepEqual(priceSnapshot({ series, pricing }).groups, []);
});