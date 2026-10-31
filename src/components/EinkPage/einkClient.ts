/**
 * Local-only API client for the e-ink tag feature.
 * Kept outside src/api/client.ts so upstream merges never touch it.
 */
import { authHeaders, reportAuthRequired } from "../../api/authToken";

export interface EinkDevice {
  address: string;
  name: string;
  rssi?: number;
}

export interface EinkConfig {
  enabled: boolean;
  device: { address: string; name: string };
  intervalMinutes: number;
  pigment: "yellow" | "red";
  theme: "dark" | "light";
  sections: { headline: boolean; stats: boolean; rows: boolean };
  background: { name: string } | null;
  backgroundDim: number;
}

export interface EinkStatus {
  enabled: boolean;
  device: { address: string; name: string };
  intervalMinutes: number;
  nextRunAt: number | null;
  lastAttemptAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  batteryMv: number | null;
  lastDurationMs: number | null;
  bridgeUrl?: string;
}

export interface EinkConfigResponse {
  config: EinkConfig;
  status: EinkStatus;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    if (res.status === 401) reportAuthRequired();
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchEinkConfig(): Promise<EinkConfigResponse> {
  return apiFetch<EinkConfigResponse>("/api/eink/config");
}

export function saveEinkConfig(patch: Partial<EinkConfig>): Promise<EinkConfigResponse> {
  return apiFetch<EinkConfigResponse>("/api/eink/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function fetchEinkDevices(): Promise<EinkDevice[]> {
  const payload = await apiFetch<{ devices?: EinkDevice[] }>("/api/eink/devices");
  return payload.devices ?? [];
}

/** Ask the bridge to render the current scene; resolves to an object URL for <img>. */
export async function fetchEinkPreview(): Promise<string> {
  const res = await fetch("/api/eink/preview", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: "{}",
  });
  if (!res.ok) {
    if (res.status === 401) reportAuthRequired();
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return URL.createObjectURL(await res.blob());
}

export function pushEinkNow(): Promise<{ ok: boolean; durationMs: number; status: EinkStatus }> {
  return apiFetch<{ ok: boolean; durationMs: number; status: EinkStatus }>("/api/eink/display", { method: "POST" });
}

export function uploadEinkBackground(dataUrl: string): Promise<EinkConfigResponse> {
  return apiFetch<EinkConfigResponse>("/api/eink/background", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dataUrl }),
  });
}

export function clearEinkBackground(): Promise<EinkConfigResponse> {
  return apiFetch<EinkConfigResponse>("/api/eink/background", { method: "DELETE" });
}