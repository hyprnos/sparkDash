import { test } from "node:test";
import assert from "node:assert/strict";
import { SglangLoadTelemetry } from "../SglangLoadTelemetry.js";
import { LlmProbe } from "../LlmProbe.js";

const row = (overrides = {}) => ({ dp_rank: 0, timestamp: 100,
  total_prefill_uncached_tokens: 100000, total_prefill_busy_us: 20000000,
  decode_moments: [10, 10, 100000, 10, 100000, 40],
  num_running_reqs: 0, num_waiting_reqs: 0, num_waiting_uncached_tokens: 500000,
  num_used_tokens: 100000, max_total_num_tokens: 1000000, token_usage: .1,
  gen_throughput: 999, ...overrides });
const loads = (...rows) => ({ loads: rows });

test("live chunked prefill is visible outside both queues; lifetime counters are not rates", () => {
  const t = new SglangLoadTelemetry();
  const seed = t.sample(loads(row()), 0);
  assert.equal(seed.prefillTpsKnown, false);
  assert.equal(seed.generationTpsKnown, false);
  const s = t.sample(loads(row({ timestamp: 102, total_prefill_uncached_tokens: 108192,
    total_prefill_busy_us: 21900000, num_waiting_uncached_tokens: 491808 })), 2000);
  assert.equal(s.prefillTps, 4096);
  assert.equal(s.runtimePhase, "prefill");
  assert.equal(s.generationTps, 0); // ignore the sticky 999 tok/s gauge
  assert.equal(s.prefillActive, true);
  assert.equal(s.requestsRunning, 0);
  assert.equal(s.requestsWaiting, 0);
  assert.equal(s.pendingPrefillTokens, 491808);
});

test("speculative decode counts produced tokens, then clears on idle and prefill", () => {
  const t = new SglangLoadTelemetry();
  t.sample(loads(row()), 0);
  const s = t.sample(loads(row({ timestamp: 102, decode_moments: [30, 30, 200000, 30, 200000, 240],
    num_running_reqs: 1, num_waiting_uncached_tokens: 0 })), 2000);
  assert.equal(s.generationTps, 100);
  assert.equal(s.prefillTps, 0);
  assert.equal(s.runtimePhase, "decode");
  const idle = t.sample(loads(row({ timestamp: 104, decode_moments: [30, 30, 200000, 30, 200000, 240],
    num_waiting_uncached_tokens: 0 })), 4000);
  assert.equal(idle.generationTps, 0);
  assert.equal(idle.runtimePhase, "idle");
});

test("queue-only work is never labelled idle; backlog is distinct from queue length", () => {
  const t = new SglangLoadTelemetry();
  t.sample(loads(row()), 0);
  const s = t.sample(loads(row({ timestamp: 102, num_waiting_reqs: 3 })), 2000);
  assert.equal(s.requestsWaiting, 3);
  assert.equal(s.runtimePhase, "pending-prefill");
  assert.equal(s.pendingPrefillTokens, 500000);
});

test("unchanged snapshots expire; failed collection clears counts and rates", () => {
  const t = new SglangLoadTelemetry();
  t.sample(loads(row()), 0);
  const stale = t.sample(loads(row()), 6000);
  assert.equal(stale.runtimePhase, "stale");
  assert.equal(stale.prefillTpsKnown, false);
  assert.equal(stale.requestsRunning, null);
  assert.equal(stale.kvCacheUsage, null);
  const lost = t.unavailable();
  assert.equal(lost.runtimePhase, "unavailable");
  assert.equal(lost.kvCacheTokens, null);
});

test("engine counter resets and long sample gaps cannot create throughput spikes", () => {
  const t = new SglangLoadTelemetry();
  t.sample(loads(row()), 0);
  const reset = t.sample(loads(row({ timestamp: 102, total_prefill_uncached_tokens: 10,
    total_prefill_busy_us: 10, decode_moments: null })), 2000);
  assert.equal(reset.prefillTpsKnown, false);
  assert.equal(reset.generationTpsKnown, false);
  const gap = t.sample(loads(row({ timestamp: 140 })), 40000);
  assert.equal(gap.prefillTpsKnown, false);
});

test("TP duplicates are deduplicated; independent DP ranks are aggregated", () => {
  const t = new SglangLoadTelemetry();
  t.sample(loads(row(), row(), row({ dp_rank: 1 })), 0);
  const one = row({ timestamp: 102, total_prefill_uncached_tokens: 108192 });
  const s = t.sample(loads(one, one, { ...one, dp_rank: 1 }), 2000);
  assert.equal(s.prefillTps, 8192);
  assert.equal(s.kvCacheTokens, 2000000);
  assert.equal(s.kvCacheTokensUsed, 200000);
  assert.equal(s.kvCacheTokensAvailable, 1800000);
  assert.equal(s.totalOutputTokens, 80); // one copy per TP rank, summed across DP
});

test("SWA pressure cannot be multiplied by full-pool capacity to invent free tokens", () => {
  const s = new SglangLoadTelemetry().sample(loads(row({ token_usage: .8 })), 0);
  assert.equal(s.kvCacheUsage, .8);
  assert.equal(s.kvCacheTokens, 1000000);
  assert.equal(s.kvCacheTokensAvailable, null);
  assert.equal(s.kvCachePressureIsHybrid, true);
});

test("missing counters are unknown; legacy loads retain the existing fallback", () => {
  assert.equal(new SglangLoadTelemetry().sample(loads({ num_running_reqs: 1 })), null);
  const s = new SglangLoadTelemetry().sample(loads(row({ total_prefill_uncached_tokens: null,
    decode_moments: undefined, num_used_tokens: null })), 0);
  assert.equal(s.prefillTpsKnown, false);
  assert.equal(s.generationTpsKnown, false);
  assert.equal(s.kvCacheTokensUsed, null);
  assert.equal(s.totalOutputTokens, null); // no decode counter in this build
});

test("complete probe keeps native load metrics after server_info and a /metrics 404", async () => {
  const p = new LlmProbe({ isLocal: true }, 8888);
  p.serverIsOpenAI = true; p.backendType = "sglang"; p.authOpen = true;
  p._lastDetectAt = Date.now();
  let r = row();
  const ok = (d) => ({ ok: true, status: 200, json: async () => d });
  p._fetch = async (url) => {
    if (url.endsWith('/v1/models')) return ok({ data: [{ id: 'native', owned_by: 'sglang' }] });
    if (url.endsWith('/server_info')) return ok({ context_length: 1048576, model_path: '/model',
      internal_states: [{ last_gen_throughput: 999 }] });
    if (url.endsWith('/v1/loads')) return ok(loads(r));
    return { ok: false, status: 404 };
  };
  await p.probe();
  r = row({ timestamp: 102, total_prefill_uncached_tokens: 108192 });
  const s = await p.probe();
  assert.equal(s.prefillTps, 4096);
  assert.equal(s.generationTps, 0);
  assert.equal(s.kvCacheUsage, .1);
  assert.equal(s.kvCacheTokens, 1000000);
  assert.equal(s.contextLength, 1048576); // context is not capacity
  assert.equal(s.metricsSource, 'sglang-loads');
  assert.equal(s.runtimePhase, 'prefill');
  // Prometheus is off, so the lifetime completion counter comes from /v1/loads
  // instead of staying at the reset baseline 0 (the "no output tokens" bug).
  assert.equal(s.totalOutputTokens, 40);
});

test("Prometheus cumulative totals win over the loads counter in the same poll", async () => {
  const p = new LlmProbe({ isLocal: true }, 8888);
  p.serverIsOpenAI = true; p.backendType = "sglang"; p.authOpen = true;
  p._lastDetectAt = Date.now();
  const ok = (d) => ({ ok: true, status: 200, json: async () => d });
  p._fetch = async (url) => {
    if (url.endsWith('/v1/models')) return ok({ data: [{ id: 'native', owned_by: 'sglang' }] });
    if (url.endsWith('/server_info')) return ok({ context_length: 1048576, model_path: '/model',
      internal_states: [{ last_gen_throughput: 999 }] });
    if (url.endsWith('/v1/loads')) return ok(loads(row()));
    if (url.endsWith('/metrics')) return { ok: true, status: 200, text: async () =>
      'sglang:generation_tokens_total 100\nsglang:prompt_tokens_total 1000\n' };
    return { ok: false, status: 404 };
  };
  const s = await p.probe();
  assert.equal(s.totalOutputTokens, 100);
});
