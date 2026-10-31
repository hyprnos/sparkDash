/**
 * Pricing — what today's tokens would have cost on a hosted API.
 *
 * Numbers come from DeepSeek's official CNY price page; the store keeps the last
 * fetched copy so a refresh failure never blanks the tag. Everything is per one
 * million tokens in CNY, which is how the vendor publishes it.
 */

/** Official CNY list prices, per 1M tokens. Off-peak is half of peak. */
export const OFFICIAL_MODELS = [
  {
    id: "deepseek-flash",
    label: "DeepSeek Flash（V4.1-Flash-1017）",
    currency: "CNY",
    cacheHit: { offPeak: 0.02, peak: 0.04 },
    cacheMiss: { offPeak: 1, peak: 2 },
    output: { offPeak: 4, peak: 8 },
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro（V4-Pro-0813）",
    currency: "CNY",
    cacheHit: { offPeak: 0.15, peak: 0.3 },
    cacheMiss: { offPeak: 4.5, peak: 9 },
    output: { offPeak: 13.5, peak: 27 },
  },
];

export const OFFICIAL_SOURCE = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";

/**
 * Peak windows are Beijing time, Mon–Fri 09:00–12:00 and 14:00–18:00 (holidays
 * excluded by the vendor; this module treats every weekday as a working day).
 */
export function isPeakHour(date = new Date()) {
  const beijing = new Date(date.getTime() + (8 * 60 + date.getTimezoneOffset()) * 60_000);
  const day = beijing.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = beijing.getHours() * 60 + beijing.getMinutes();
  const inWindow = (start, end) => minutes >= start && minutes < end;
  return inWindow(9 * 60, 12 * 60) || inWindow(14 * 60, 18 * 60);
}

export function findOfficialModel(id) {
  return OFFICIAL_MODELS.find((model) => model.id === id) || null;
}

/**
 * Resolve the rates to charge with: either an official preset at the selected
 * tariff, or the manually entered numbers the user stored.
 */
export function resolveRates(pricing, { now = new Date() } = {}) {
  const tariff = pricing?.tariff === "peak" || pricing?.tariff === "off-peak"
    ? pricing.tariff
    : isPeakHour(now)
      ? "peak"
      : "off-peak";
  const official = findOfficialModel(pricing?.modelId);
  if (official) {
    return {
      label: official.label,
      currency: "CNY",
      tariff,
      cacheHit: official.cacheHit[tariff === "peak" ? "peak" : "offPeak"],
      cacheMiss: official.cacheMiss[tariff === "peak" ? "peak" : "offPeak"],
      output: official.output[tariff === "peak" ? "peak" : "offPeak"],
      source: "official",
    };
  }
  return {
    label: typeof pricing?.label === "string" && pricing.label ? pricing.label : "自定义模型",
    currency: "CNY",
    tariff,
    cacheHit: Math.max(0, Number(pricing?.cacheHitPrice) || 0),
    cacheMiss: Math.max(0, Number(pricing?.cacheMissPrice) || 0),
    output: Math.max(0, Number(pricing?.outputPrice) || 0),
    source: "manual",
  };
}

/** Cost in CNY for the given token counts at the resolved rates. */
export function computeCost(tokens, rates) {
  const cached = Math.max(0, Number(tokens?.cachedTokens) || 0);
  const prompt = Math.max(0, Number(tokens?.promptTokens) || 0);
  const completion = Math.max(0, Number(tokens?.completionTokens) || 0);
  const uncached = Math.max(0, prompt - cached);
  const perMillion = 1_000_000;
  return (
    (uncached * (rates?.cacheMiss || 0) + cached * (rates?.cacheHit || 0) + completion * (rates?.output || 0)) /
    perMillion
  );
}

/** "¥0.42" — three significant digits is all a 400 px panel can show. */
export function formatCny(value) {
  const amount = Number(value) || 0;
  if (amount <= 0) return "¥0";
  if (amount < 1) return `¥${amount.toFixed(2)}`;
  if (amount < 100) return `¥${amount.toFixed(1)}`;
  return `¥${Math.round(amount)}`;
}

/**
 * Pull the CNY table out of the official docs page.
 *
 * The published table interleaves both models per row (cache-hit off-peak,
 * cache-hit peak, cache-miss off-peak, …, output peak), so the amounts are read
 * in order and split by column. Returns null when the layout changed enough that
 * parsing would be guesswork — callers keep the previous numbers then.
 */
export function parseOfficialPricing(html) {
  const text = String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
  const start = text.indexOf("缓存命中");
  if (start < 0) return null;
  const window = text.slice(start, start + 4000);
  const amounts = [...window.matchAll(/(\d+(?:\.\d+)?)\s*元/g)].map((match) => Number(match[1]));
  if (amounts.length < 12) return null;
  const [flashHitOff, proHitOff, flashHitPeak, proHitPeak, flashMissOff, proMissOff, flashMissPeak, proMissPeak, flashOutOff, proOutOff, flashOutPeak, proOutPeak] =
    amounts.slice(0, 12);
  const flash = { hit: flashHitOff, miss: flashMissOff, output: flashOutOff, hitPeak: flashHitPeak, missPeak: flashMissPeak, outputPeak: flashOutPeak };
  const pro = { hit: proHitOff, miss: proMissOff, output: proOutOff, hitPeak: proHitPeak, missPeak: proMissPeak, outputPeak: proOutPeak };
  if (!flash.miss || !pro.miss) return null;
  return { flash, pro };
}

/** Apply a parsed table to the official presets (off-peak is the published base). */
export function applyOfficialPricing(parsed) {
  if (!parsed) return false;
  const next = OFFICIAL_MODELS.map((model) => ({ ...model }));
  const patch = (id, values) => {
    if (!values) return;
    const model = next.find((entry) => entry.id === id);
    if (!model) return;
    model.cacheMiss = { offPeak: values.miss, peak: values.missPeak ?? values.miss * 2 };
    model.cacheHit = { offPeak: values.hit, peak: values.hitPeak ?? values.hit * 2 };
    model.output = { offPeak: values.output, peak: values.outputPeak ?? values.output * 2 };
  };
  patch("deepseek-flash", parsed.flash);
  patch("deepseek-v4-pro", parsed.pro);
  OFFICIAL_MODELS.length = 0;
  OFFICIAL_MODELS.push(...next);
  return true;
}