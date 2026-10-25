import fs from 'node:fs';
import path from 'node:path';
import { LLM_TOKEN_JSON_PATH } from '../config.js';

// Opt-in, local head only. No Docker socket, request bodies or inference changes.
// Prefix hits are reported once on admission; chunk continuations pass prefix_len=0.
// These are scheduler prefill-work counts (same semantics as realtime_tokens_total),
// not completed-request billing counts; retracted work can be counted again.
export function parsePrefillLog(line) {
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  const m = /^\[[^\]]+ TP0\] Prefill batch(?: \[\d+\])?, #new-seq: \d+, #new-token: (\d+), #cached-token: (\d+),/.exec(row.log || '');
  const at = Date.parse(row.time);
  if (!m || !Number.isFinite(at)) return null;
  const computed = Number(m[1]), cached = Number(m[2]);
  return Number.isSafeInteger(computed + cached) ? { at, computed, cached } : null;
}

export function readSglangTokenLogs(ledger, {
  configPath = path.join(path.dirname(LLM_TOKEN_JSON_PATH), 'sglang-token-log-sources.json'),
  dockerRoot = '/host/root/var/lib/docker/containers',
  snapshots = null,
} = {}) {
  if (!fs.existsSync(configPath)) return;
  const sources = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  for (const source of sources) {
    if (snapshots) {
      const snap = snapshots.find((s) => s.id === source.sparkId);
      const entry = snap?.metrics?.llm?.[snap?.llmPorts?.indexOf(source.port)];
      // Never mix two accounting sources or backfill over a native total.
      if (!entry?.available || entry.totalPromptTokens != null || entry.metricsSource !== 'sglang-loads') continue;
    }
    if (!source.containerName || !source.sparkId || !source.modelId || !Number.isInteger(source.port)) continue;
    for (const id of fs.readdirSync(dockerRoot)) {
      if (!/^[a-f0-9]{64}$/.test(id)) continue;
      const dir = path.join(dockerRoot, id);
      let config;
      try { config = JSON.parse(fs.readFileSync(path.join(dir, 'config.v2.json'), 'utf8')); } catch { continue; }
      if (config.Name !== '/' + source.containerName) continue;
      const file = path.join(dir, id + '-json.log');
      const stat = fs.statSync(file);
      const cursorKey = `${source.sparkId}:${source.port}:${id}:${stat.ino}`;
      const offset = ledger._data.logCursors?.[cursorKey] || 0;
      if (stat.size < offset) throw new Error('SGLang log truncated; refusing to double-count');
      if (stat.size === offset) continue;
      // Bounded reads; only complete JSON lines advance the persisted offset.
      const size = Math.min(stat.size - offset, 8 * 1024 * 1024);
      const data = Buffer.alloc(size);
      const fd = fs.openSync(file, 'r');
      let bytes;
      try { bytes = fs.readSync(fd, data, 0, size, offset); } finally { fs.closeSync(fd); }
      const end = data.subarray(0, bytes).lastIndexOf(10);
      if (end < 0) continue;
      const events = data.subarray(0, end).toString('utf8').split('\n').map(parsePrefillLog).filter(Boolean);
      ledger.importPrefillEvents(source, cursorKey, offset + end + 1, events);
    }
  }
}
