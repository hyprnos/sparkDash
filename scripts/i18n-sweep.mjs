#!/usr/bin/env node
/**
 * Sweep the frontend for user-visible strings that never went through the i18n
 * catalog. Deliberately dependency-free: it looks for the shapes that carry copy
 * in this codebase (JSX text nodes, copy-bearing attributes, object-literal
 * labels, `const …Text/Label = "…"` helpers) and ignores identifiers, units and
 * product names that are allowed to stay English.
 *
 * Usage: node scripts/i18n-sweep.mjs [--quiet] [paths…]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-baked", ".git", "locales", "__tests__", "testing"]);

const PATTERNS = [
  { kind: "jsx-text", re: />\s*([A-Za-z\u4e00-\u9fff][^<>{}]{2,}?)\s*</g },
  { kind: "jsx-attr", re: /\b(title|placeholder|aria-label|aria-description|alt)=["']([^"']{3,})["']/g, value: 2 },
  { kind: "object", re: /\b(label|title|hint|help|description|placeholder|text|message)\s*:\s*["']([^"']{3,})["']/g, value: 2 },
  { kind: "const", re: /\b(?:const|let)\s+\w*(?:Text|Label|Copy|Hint|Message|Title)\w*\s*=\s*["']([^"']{3,})["']/g, value: 1 },
];

const ALLOW = [
  /^[\s\d.,:%+\-–—/()#*×·→←↑↓|]+$/,
  /^(?:https?:|mailto:|#)/,
  /^[a-z][\w-]*$/,
  /^[a-z]+(\.[a-z]+)+$/,
  /^(?:sparkDash|Sparks?|DGX|GPU|CPU|RAM|VRAM|LLM|KV|SSH|HTTP|HTTPS|JSON|CSV|PID|MTU|MAC|IP|URL|API|ID|UTC|W|kWh|Wh|GB|MB|TB|dBm|tok\/s|tok|TTFT|SM|RoCE|SGLang|Hermes|ComfyUI|Comfy|Tailscale|Tailnet|Prometheus|Grafana|MQTT|ntfy|Discord|Slack|GitHub|X|OLED|OOM|Decode|Prefill|Quality|Showcase|NRF_EPD_[A-Z0-9]+|DeepSeek[\w.-]*|Claude[\w.-]*|GPT[\w.-]*|Gemini[\w.-]*|OpenClaw|OpenCode|Codex|ESP32)$/,
  /^\S+\.(?:css|png|svg|json|tsx?|js|woff2?)$/,
];
const HAS_WORD = /[A-Za-z\u4e00-\u9fff]{3,}/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (/\.(tsx|ts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function translatable(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || !HAS_WORD.test(text)) return false;
  if (text.includes("${")) return false;
  if (/^(?:aria-|data-|role=|is-|r-)/.test(text)) return false;
  /* leftovers from expression fragments, not copy */
  if (/[(){}?=:]|=>/.test(text)) return false;
  if (/^(?:Promise|Object|Array|String|Number|Boolean|Math|JSON)$/.test(text)) return false;
  return !ALLOW.some((re) => re.test(text));
}

function scanFile(file) {
  const source = fs.readFileSync(file, "utf8");
  const rows = [];
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    for (const pattern of PATTERNS) {
      const re = new RegExp(pattern.re.source, pattern.re.flags);
      let match;
      while ((match = re.exec(line)) !== null) {
        const value = match[pattern.value ?? 1];
        if (translatable(value)) rows.push({ line: index + 1, kind: pattern.kind, text: value.trim() });
      }
    }
  });
  return rows;
}

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const targets = args.filter((arg) => !arg.startsWith("--"));
const files = (targets.length ? targets.map((t) => path.resolve(ROOT, t)) : [path.join(ROOT, "src")])
  .flatMap((target) => (fs.statSync(target).isDirectory() ? walk(target) : [target]));

const report = [];
let total = 0;
for (const file of files) {
  const rows = scanFile(file);
  if (!rows.length) continue;
  total += rows.length;
  report.push({ file: path.relative(ROOT, file), rows });
}

if (!quiet) {
  for (const entry of report.sort((a, b) => b.rows.length - a.rows.length)) {
    console.log(`\n${entry.file} (${entry.rows.length})`);
    for (const row of entry.rows.slice(0, 25)) {
      console.log(`  ${String(row.line).padStart(4)}  ${row.kind.padEnd(10)} ${row.text.slice(0, 110)}`);
    }
    if (entry.rows.length > 25) console.log(`  … ${entry.rows.length - 25} more`);
  }
}
console.log(`\n${total} candidate strings in ${report.length} files`);
