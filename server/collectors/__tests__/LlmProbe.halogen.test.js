/** Unit tests for Halogen detection and its llama.cpp-format /metrics. */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

function jsonRes(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function textRes(body) {
  return { ok: true, status: 200, json: async () => ({}), text: async () => body };
}

function notFound() {
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
}

const MODELS = {
  object: "list",
  data: [{ id: "halogen-qwen3.8-flash-next", object: "model", owned_by: "halogen", max_model_len: 262144 }],
};

function metrics({ prompt, generated, prefillTps, generationTps, running, kvTokens = 914688, kvRatio = 0.4361572266, cachedPrompt = 9084834 }) {
  return [
    `llamacpp:prompt_tokens_total ${prompt}`,
    `llamacpp:prompt_seconds_total 30.2833`,
    `llamacpp:tokens_predicted_total ${generated}`,
    `llamacpp:tokens_predicted_seconds_total 182.667`,
    `llamacpp:prompt_tokens_seconds ${prefillTps}`,
    `llamacpp:predicted_tokens_seconds ${generationTps}`,
    `llamacpp:requests_processing ${running}`,
    `llamacpp:kv_cache_tokens ${kvTokens}`,
    `llamacpp:kv_cache_usage_ratio ${kvRatio}`,
    `halogen:prompt_tokens_cached_total ${cachedPrompt}`,
    "",
  ].join("\n");
}

const HEALTH = {
  status: "ok",
  slots: 4,
  context: 1048576,
  in_flight: 1,
  queued: 2,
  busy: true,
};

test("_detectServerType: owned_by halogen → halogen, not vLLM or llama.cpp", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.140" }, 8731);
  probe._fetch = async (url) => String(url).endsWith("/v1/models") ? jsonRes(MODELS) : notFound();
  await probe._detectServerType();
  assert.equal(probe.serverIsOpenAI, true);
  assert.equal(probe.backendType, "halogen");
});

test("_detectServerType: Halogen health fingerprint wins over llama.cpp-shaped /slots", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.140" }, 8731);
  const seen = [];
  probe._fetch = async (url) => {
    const value = String(url);
    seen.push(value);
    if (value.endsWith("/health")) {
      return jsonRes({
        status: "ok",
        metrics: "/metrics",
        capability_probe: "ok",
        endpoints: ["/v1/models", "/v1/responses"],
      });
    }
    if (value.endsWith("/slots")) {
      return jsonRes([{ id: 0, n_ctx: 262144 }, { id: 1, n_ctx: 262144 }]);
    }
    return notFound();
  };
  await probe._detectServerType();
  assert.equal(probe.serverIsOpenAI, true);
  assert.equal(probe.backendType, "halogen");
  assert.equal(seen.some((url) => url.endsWith("/slots")), false);
});

test("_detectServerType: Halogen startup health wins over llama.cpp-shaped /slots", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.140" }, 8731);
  const seen = [];
  probe._fetch = async (url) => {
    const value = String(url);
    seen.push(value);
    if (value.endsWith("/health")) return jsonRes({
      status: "engine_unresponsive",
      metrics: "/metrics",
      capability_probe: "failed",
      endpoints: ["/v1/models", "/v1/responses"],
    });
    if (value.endsWith("/slots")) return jsonRes([{ id: 0, n_ctx: 262144 }]);
    return notFound();
  };
  await probe._detectServerType();
  assert.equal(probe.serverIsOpenAI, true);
  assert.equal(probe.backendType, "halogen");
  assert.equal(seen.some((url) => url.endsWith("/slots")), false);
});

test("_detectServerType: known halogen skips the protected /slots probe", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.140" }, 8731);
  probe.backendType = "halogen";
  const seen = [];
  probe._fetch = async (url) => {
    seen.push(String(url));
    return String(url).endsWith("/v1/models") ? jsonRes(MODELS) : notFound();
  };
  await probe._detectServerType();
  assert.equal(seen.some((url) => url.endsWith("/slots")), false);
  assert.equal(probe.backendType, "halogen");
});

test("probe: Halogen metrics provide live rates, request count and cumulative tokens", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.140" }, 8731);
  let body = metrics({ prompt: 52525, generated: 11992, prefillTps: 1734.45, generationTps: 65.65, running: 0 });
  probe._fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/v1/models")) return jsonRes(MODELS);
    if (value.endsWith("/metrics")) return textRes(body);
    if (value.endsWith("/health")) return jsonRes(HEALTH);
    return notFound();
  };
  let snap = await probe.probe();
  assert.equal(snap.backend, "halogen");
  assert.equal(snap.modelId, "halogen-qwen3.8-flash-next");
  assert.equal(snap.contextLength, 262144);
  // Processed (52525) + prompt-cache covered (9084834): the cache figure must
  // never exceed the total, or every hit rate reads as 100%.
  assert.equal(snap.totalPromptTokens, 9084834 + 52525);
  assert.equal(snap.totalOutputTokens, 11992);
  assert.equal(snap.totalCachedTokens, 9084834);
  assert.equal(snap.prefillTps, 1734.45);
  assert.equal(snap.generationTps, 65.65);
  assert.equal(snap.requestsRunning, 0);
  assert.equal(snap.kvCacheTokens, 914688);
  assert.equal(snap.kvCacheUsage, 0.4361572266);
  assert.equal(snap.slotsTotal, 4);
  assert.equal(snap.slotsActive, 1);
  assert.equal(snap.requestsWaiting, 2);

  body = metrics({ prompt: 53000, generated: 12040, prefillTps: 900, generationTps: 40, running: 1 });
  probe.lastProbeTime = Date.now() - 1000;
  snap = await probe.probe();
  assert.equal(snap.totalPromptTokens, 9084834 + 53000);
  assert.equal(snap.totalOutputTokens, 12040);
  assert.equal(snap.requestsRunning, 1);
});

test("Halogen live counters report in-flight throughput and reset safely", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.140" }, 8731);
  const sample = (prompt, generated) => [
    "llamacpp:requests_processing 1",
    "llamacpp:prompt_tokens_seconds 9999",
    "llamacpp:predicted_tokens_seconds 9999",
    `halogen:live_prompt_tokens_total ${prompt}`,
    `halogen:live_predicted_tokens_total ${generated}`,
  ].join("\n");

  probe._applyHalogenMetrics(sample(10000, 1000), 1000);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.generationTps, 0);
  probe._applyHalogenMetrics(sample(12000, 1060), 3000);
  assert.equal(probe.prefillTps, 1000);
  assert.equal(probe.generationTps, 30);
  assert.equal(probe.prefillActive, true);
  assert.equal(probe.decodeActive, true);
  probe._applyHalogenMetrics(sample(12000, 1060), 4000);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.generationTps, 0);
  probe._applyHalogenMetrics(sample(5, 3), 5000);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.generationTps, 0);
  probe._applyHalogenMetrics(sample(105, 23), 7000);
  assert.equal(probe.prefillTps, 50);
  assert.equal(probe.generationTps, 10);
  probe._applyHalogenMetrics(sample(205, 43), 20000);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.generationTps, 0);
  probe._resetDetection();
  probe._applyHalogenMetrics(sample(300, 60), 21000);
  assert.equal(probe.generationTps, 0);
});

test("probe: Halogen live counters reach the monitoring snapshot", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.140" }, 8731);
  let live = [200, 50];
  probe._fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/v1/models")) return jsonRes(MODELS);
    if (value.endsWith("/health")) return jsonRes(HEALTH);
    if (value.endsWith("/metrics")) return textRes([
      "llamacpp:requests_processing 1",
      `halogen:live_prompt_tokens_total ${live[0]}`,
      `halogen:live_predicted_tokens_total ${live[1]}`,
    ].join("\n"));
    return notFound();
  };
  await probe.probe();
  probe._halogenLiveCounts.time -= 1000;
  live = [2200, 110];
  const snap = await probe.probe();
  assert.ok(snap.prefillTps > 1900 && snap.prefillTps <= 2000);
  assert.ok(snap.generationTps > 57 && snap.generationTps <= 60);
  assert.equal(snap.requestsRunning, 1);
});
