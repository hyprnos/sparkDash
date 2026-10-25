// Native load snapshots work even when the engine's Prometheus endpoint is off.
// Rates use deltas, never sticky gen_throughput or lifetime / uptime averages.
const nonnegative = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const sumKnown = (values) => values.every((v) => v != null) ? values.reduce((a, b) => a + b, 0) : null;
const round = (n) => Math.round(n * 100) / 100;

export class SglangLoadTelemetry {
  constructor() {
    this.previous = new Map();
    this.last = null;
  }

  sample(payload, now = Date.now()) {
    const input = Array.isArray(payload) ? payload : payload?.loads;
    if (!Array.isArray(input) || !input.some((r) => r &&
        ("total_prefill_uncached_tokens" in r || "decode_moments" in r))) return null;
    // A DP rank owns one pool; TP replicas must not multiply its counters.
    const byRank = new Map();
    input.forEach((r, i) => {
      if (!r || typeof r !== "object") return;
      const rank = r.dp_rank ?? `unlabelled-${i}`;
      if (!byRank.has(rank) || r.timestamp > byRank.get(rank).timestamp) byRank.set(rank, r);
    });
    const rates = [];
    let age = 0;
    for (const [rank, r] of byRank) {
      const ts = nonnegative(r.timestamp);
      const p = nonnegative(r.total_prefill_uncached_tokens);
      const busy = nonnegative(r.total_prefill_busy_us);
      // _accumulate_decode_moment: [steps, sum(batch), sum(us),
      // sum(batch^2), sum(batch*us), generated tokens]. null means no steps yet.
      const g = r.decode_moments === null ? 0 : nonnegative(r.decode_moments?.[5]);
      const prev = this.previous.get(rank);
      const unchanged = prev && ts != null && ts === prev.ts;
      const touched = unchanged ? prev.touched : now;
      age = Math.max(age, now - touched);
      if (unchanged) {
        rates.push(prev.rates);
        continue;
      }
      const dt = prev && ts != null ? ts - prev.ts : 0;
      const valid = dt > 0 && dt <= 10;
      const pKnown = valid && p != null && prev.p != null && p >= prev.p &&
        (busy == null || prev.busy == null || busy >= prev.busy);
      const gKnown = valid && g != null && prev.g != null && g >= prev.g;
      const idle = r.num_running_reqs === 0 && r.num_waiting_reqs === 0 &&
        r.num_waiting_uncached_tokens === 0;
      const rate = {
        p: pKnown ? (p - prev.p) / dt : 0,
        g: gKnown ? (g - prev.g) / dt : 0,
        pKnown: pKnown || (!prev && idle && p === 0),
        gKnown: gKnown || (!prev && idle && g === 0),
      };
      rates.push(rate);
      this.previous.set(rank, { ts, p, busy, g, touched, rates: rate });
    }
    for (const key of this.previous.keys()) if (!byRank.has(key)) this.previous.delete(key);
    const rows = [...byRank.values()];
    const stale = age > 5000 || rows.some((r) => nonnegative(r.timestamp) == null);
    const running = sumKnown(rows.map((r) => nonnegative(r.num_running_reqs)));
    const waiting = sumKnown(rows.map((r) => nonnegative(r.num_waiting_reqs)));
    const pending = sumKnown(rows.map((r) => nonnegative(r.num_waiting_uncached_tokens)));
    const capacity = sumKnown(rows.map((r) => nonnegative(r.max_total_num_tokens)));
    const used = sumKnown(rows.map((r) => nonnegative(r.num_used_tokens)));
    const pressures = rows.map((r) => nonnegative(r.token_usage));
    const pressure = pressures.every((v) => v != null) ? Math.min(1, Math.max(...pressures)) : null;
    // Hybrid SWA reports max(full usage, sliding-window usage), with different
    // denominators. Do NOT turn that pressure into fictitious free FULL tokens.
    const fullPoolMatches = rows.every((r) => r.max_total_num_tokens > 0 &&
      nonnegative(r.num_used_tokens) != null && nonnegative(r.token_usage) != null &&
      Math.abs(r.num_used_tokens / r.max_total_num_tokens - r.token_usage) <= 0.0001);
    const pKnown = !stale && rates.every((r) => r.pKnown);
    const gKnown = !stale && rates.every((r) => r.gKnown);
    const prefill = pKnown ? round(rates.reduce((a, r) => a + r.p, 0)) : 0;
    const decode = gKnown ? round(rates.reduce((a, r) => a + r.g, 0)) : 0;
    // Lifetime completion counter for the token ledger when Prometheus is off.
    // decode_moments is null until the first decode step (meaning zero, not
    // unknown); a build with no such field at all reports null instead of a
    // misleading 0. TP copies were deduplicated above; DP ranks sum.
    const hasMomentField = rows.some((r) => r.decode_moments !== undefined);
    const totalOutputTokens = !hasMomentField ? null : sumKnown(rows.map((r) =>
      r.decode_moments == null ? 0 : nonnegative(r.decode_moments[5])));
    const phase = stale ? "stale" : prefill > 0 && decode > 0 ? "mixed" :
      prefill > 0 ? "prefill" : decode > 0 ? "decode" :
      pending > 0 ? "pending-prefill" : running > 0 ? "sampling" :
      waiting > 0 ? "waiting" : "idle";
    this.last = {
      metricsSource: "sglang-loads", runtimePhase: phase,
      telemetryAgeMs: age, telemetryStale: stale,
      telemetryTimestamp: rows.every((r) => nonnegative(r.timestamp) != null)
        ? Math.min(...rows.map((r) => r.timestamp)) * 1000 : null,
      prefillTps: prefill, uncachedPrefillTps: pKnown ? prefill : null,
      cachedPrefillTps: null, prefillTpsKnown: pKnown,
      generationTps: decode, generationTpsKnown: gKnown,
      prefillActive: !stale && prefill > 0,
      pendingPrefillTokens: stale ? null : pending,
      requestsRunning: stale ? null : running, requestsWaiting: stale ? null : waiting,
      slotsActive: stale ? null : running,
      kvCacheTokens: stale ? null : capacity,
      kvCacheTokensUsed: stale ? null : used,
      kvCacheUsage: stale ? null : pressure,
      kvCacheTokensAvailable: !stale && fullPoolMatches && capacity != null && used != null
        ? Math.max(0, capacity - used) : null,
      kvCachePressureIsHybrid: !fullPoolMatches,
      totalOutputTokens,
    };
    return this.last;
  }

  unavailable() {
    if (!this.last) return null;
    return { ...this.last, runtimePhase: "unavailable", telemetryStale: true,
      prefillTps: 0, generationTps: 0, prefillTpsKnown: false, generationTpsKnown: false,
      prefillActive: false, uncachedPrefillTps: null, pendingPrefillTokens: null,
      requestsRunning: null, requestsWaiting: null, slotsActive: null,
      kvCacheUsage: null, kvCacheTokens: null, kvCacheTokensUsed: null,
      kvCacheTokensAvailable: null };
  }
}
