/**
 * Local-only API client for the llm-token-totals feature.
 * Sits outside src/api/client.ts so upstream merges never touch it.
 * apiFetch is a small local copy: client.ts does not export it, and importing
 * client.ts would pull its other handlers into any lazy chunk.
 */
import type { LlmTokenRange, LlmTokenTotalsResponse } from "./llmTokenTypes";
import { authHeaders, reportAuthRequired } from "./authToken";

export function fetchLlmTokenTotals(range?: LlmTokenRange): Promise<LlmTokenTotalsResponse> {
  return apiFetch(range && range !== "all" ? `/api/llm-token-totals?range=${range}` : "/api/llm-token-totals");
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { ...authHeaders(), ...(opts?.headers as Record<string, string> | undefined) } });
  if (!res.ok) {
    if (res.status === 401) reportAuthRequired();
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface LlmTokenCostGroup {
  key: string;
  sparkId: string;
  port: number;
  modelId: string;
  tokens: { promptTokens: number; completionTokens: number; cachedTokens: number };
  cost: number;
  formatted: string;
  profileId: string;
  profileName: string;
  label: string;
  tariff: string;
  source: string;
  rates: { cacheHit: number; cacheMiss: number; output: number };
}

export interface LlmTokenCost {
  range: string;
  currency: string;
  cost: number;
  formatted: string;
  tokens: { promptTokens: number; completionTokens: number; cachedTokens: number; total: number };
  modelId: string;
  label: string;
  tariff: string;
  /** Hours in the window charged at the peak tariff (0 for a flat or pinned price). */
  peakHours?: number;
  /** The configured tariff mode: "auto" prices each hour at its own rate. */
  tariffMode?: string;
  /** Both published tariffs, so an hourly estimate can show what was charged. */
  peakRates?: { cacheHit: number; cacheMiss: number; output: number } | null;
  offPeakRates?: { cacheHit: number; cacheMiss: number; output: number } | null;
  source: string;
  rates: { cacheHit: number; cacheMiss: number; output: number };
  pricingUpdatedAt: number | null;
  groups: LlmTokenCostGroup[];
}

/** Cost of the same token totals at the pricing configured for the e-paper tag. */
export function fetchLlmTokenCost(range: string): Promise<LlmTokenCost> {
  return apiFetch<LlmTokenCost>(`/api/llm-token-cost?range=${encodeURIComponent(range)}`);
}
