import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { decodeBenchSamplingLabel, decodeBenchSamplingMixed } from "./decodeSampling";
import { createPortal } from "react-dom";
import "../../styles/dialogs.css";
import {
  cancelDecodeBench,
  clearDecodeBenchHistory,
  getDecodeBench,
  listDecodeBench,
  startDecodeBench,
} from "../../api/client";
import type { DecodeBenchJob, DecodeBenchPromptType, LlmBenchTarget } from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";
import { BenchCopyButton } from "./BenchCopyButton";
import { BenchSwitcher, type BenchKind } from "./BenchSwitcher";
import { decodeTypeHint, decodeTypeLabel } from "./benchTypeLabels";
import { XIcon } from "../ui/icons";
import { buildDecodeShareCard } from "./benchShareCard";
import { HistoryTable, PageCard, PageEmpty, PageLayout } from "../bench/sparkdash/pageParts";
import { decodeHistoryRow } from "../bench/sparkdash/historyRows";
import { LiveTps } from "../bench/sparkdash/LiveTps";
import { formatDuration } from "../../shared/formatDuration";
import { formatLlmBaseUrl } from "../../shared/llmTarget.js";
import {
  PREFILL_MAX_CONTEXT_SIZE,
  PREFILL_MIN_CONTEXT_SIZE,
  formatContextSize,
  parseContextSize,
} from "../../shared/prefillBench.js";
import {
  DECODE_BENCH_DEFAULT_TYPE,
  DECODE_BENCH_TYPE_META,
  decodeBenchTypeLabel,
  normalizeDecodeBenchType,
} from "../../shared/llmPrompts.js";

const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32] as const;
const DEFAULT_SELECTED = [1, 2];
const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_THINKING = true;
const DEFAULT_PROMPT_TYPE: DecodeBenchPromptType = DECODE_BENCH_DEFAULT_TYPE;
/** Start-context presets (tokens); 0 starts empty. A custom size can be typed too. */
const CONTEXT_PRESETS = [0, 16384, 32768, 65536, 131072, 262144] as const;

/** "128k", "131072" → tokens; "" → 0 (empty context); anything else → null. */
function parseContextDraft(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (t === "") return 0;
  const m = /^(\d+)(k?)$/.exec(t);
  if (!m) return null;
  const n = parseInt(m[1], 10) * (m[2] ? 1024 : 1);
  return n === 0 ? 0 : parseContextSize(n);
}

function contextLabel(tokens: number | undefined): string {
  return tokens && tokens > 0 ? ` · ${formatContextSize(tokens)} ctx` : "";
}

interface BenchmarkDialogProps {
  /** Modal only; the page variant is always open. */
  open?: boolean;
  onClose?: () => void;
  /** "page" renders the same content inline (no overlay, close button or switcher). */
  variant?: "modal" | "page";
  sparkId: string;
  llmPort: number;
  modelId: string | null;
  /** Exact served request IDs; undefined for targets without model discovery. */
  models?: string[];
  remoteTarget?: LlmBenchTarget | null;
  /** Settings → Benchmark share image: the copy button also carries the card. */
  shareImage?: boolean;
  /** Unit display name for the share-card header. */
  sparkName?: string | null;
  /** Probe backend id for the share card's engine chip. */
  engine?: string | null;
  /** Probe exposure/auth posture for the share-card chip. */
  posture?: { label: string; level: "ok" | "warn" | "danger" } | null;
  /** Switch to another benchmark dialog (Decode / Prefill / Quality). Switcher hidden when omitted. */
  onSwitchBench?: (kind: BenchKind) => void;
  /** The engine's current generation tok/s (monitor reading); shown live while a run is in flight. */
  liveTps?: number | null;
}

function useEscape(onClose: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, enabled]);
}

/** Lock body scroll while the modal is open (important on iOS). */
function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [locked]);
}

function statusLabel(t: (key: string) => string, status: DecodeBenchJob["status"]): string {
  switch (status) {
    case "running":
      return t("shared.running");
    case "completed":
      return t("shared.completed");
    case "failed":
      return t("shared.failed");
    case "cancelled":
      return t("shared.cancelled");
    default:
      return status;
  }
}

function formatTtft(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

/**
 * Build a plain-text benchmark summary for the clipboard.
 * Format: "<model> | decode tok/s results:" header, then one line per
 * concurrency level with decode tok/s and key metrics.
 */
function buildShareText(job: DecodeBenchJob, modelId: string | null, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const name = modelId || t("decodeBench.unknownModel");
  const typeLabel = decodeTypeLabel(t, job.config?.promptType);
  const ctx = job.config?.contextTokens
    ? t("decodeBench.shareContext", { size: formatContextSize(job.config.contextTokens) })
    : "";
  const head = t("decodeBench.shareHeader", {
    model: name,
    type: typeLabel,
    sampling: decodeBenchSamplingLabel(job.config, t),
    context: ctx,
  });

  const lines = job.results
    .slice()
    .sort((a, b) => a.concurrency - b.concurrency)
    .map((r) => {
      if (r.totalDecodeTokens > 0 || r.totalCompletionTokens > 0) {
        const agg = r.aggregateDecodeTps > 0 ? r.aggregateDecodeTps : r.meanDecodeTps;
        return t("decodeBench.shareLine", {
          concurrency: r.concurrency,
          aggregate: agg.toFixed(1),
          stream: r.meanDecodeTps.toFixed(1),
          ttft: formatTtft(r.meanTtftMs),
        });
      }
      return t("decodeBench.shareFailed", {
        concurrency: r.concurrency,
        error: r.error ? t("decodeBench.shareFailedReason", { error: r.error }) : "",
      });
    });

  return [head, "", ...lines].join("\n");
}

function resultAgg(r: DecodeBenchJob["results"][number]): number {
  return r.aggregateDecodeTps > 0 ? r.aggregateDecodeTps : r.meanDecodeTps;
}

function ResultRow({ r, max }: { r: DecodeBenchJob["results"][number]; max: number }) {
  const { t } = useTranslation("spark");
  const pct = max > 0 ? Math.max(2, Math.round((resultAgg(r) / max) * 100)) : 0;
  return (
    <article className="bench-result-row" title={r.error || undefined}>
      <div className="bench-result-row__load">
        <span className="bench-result-row__badge">×{r.concurrency}</span>
        <div className="bench-result-row__facts">
          {r.contextTokens ? (
            <>
              <span className={r.warning ? "text-warning" : undefined}>
                {t("decodeBench.ctxTag", { size: formatContextSize(r.contextTokens) })} <strong>{formatContextSize(r.contextTokens)}</strong>
              </span>
              <span className="bench-result-row__sep" aria-hidden>
                ·
              </span>
            </>
          ) : null}
          <span>
            TTFT <strong>{formatTtft(r.meanTtftMs)}</strong>
          </span>
          <span className="bench-result-row__sep" aria-hidden>
            ·
          </span>
          <span className={r.streamsFailed ? "text-warning" : undefined}>
            <strong>
              {r.streamsOk}/{r.streamsOk + r.streamsFailed}
            </strong>{" "}
            {t("bench.streams")}
          </span>
        </div>
      </div>

      <div className="bench-result-row__speeds">
        <div className="bench-result-row__metric">
          <span className="bench-result-row__label">{t("bench.aggregate")}</span>
          <span className="bench-result-row__value bench-result-row__value--accent">
            {(r.aggregateDecodeTps > 0 ? r.aggregateDecodeTps : r.meanDecodeTps).toFixed(1)}
            <span className="bench-result-row__unit">tok/s</span>
          </span>
        </div>
        <div className="bench-result-row__metric">
          <span className="bench-result-row__label">{t("bench.stream")}</span>
          <span className="bench-result-row__value">
            {r.meanDecodeTps.toFixed(1)}
            <span className="bench-result-row__unit">tok/s</span>
          </span>
        </div>
      </div>

      <div className="bench-result-row__bar" aria-hidden>
        <i style={{ width: `${pct}%` }} />
      </div>
      {r.warning && <p className="bench-sheet__hint text-warning">{r.warning}</p>}
    </article>
  );
}

export function BenchmarkDialog({
  open: openProp = true,
  onClose = () => {},
  variant = "modal",
  sparkId,
  llmPort,
  modelId,
  models,
  remoteTarget = null,
  shareImage = false,
  sparkName = null,
  engine = null,
  posture = null,
  onSwitchBench,
  liveTps = null,
}: BenchmarkDialogProps) {
  const { t } = useTranslation("spark");
  const isPage = variant === "page";
  const open = isPage || openProp;
  const [history, setHistory] = useState<DecodeBenchJob[]>([]);
  const [selected, setSelected] = useState<number[]>([...DEFAULT_SELECTED]);
  const [maxTokensDraft, setMaxTokensDraft] = useState(String(DEFAULT_MAX_TOKENS));
  const [promptType, setPromptType] = useState<DecodeBenchPromptType>(DEFAULT_PROMPT_TYPE);
  const [temperatureDraft, setTemperatureDraft] = useState(String(DEFAULT_TEMPERATURE));
  const [thinking, setThinking] = useState(DEFAULT_THINKING);
  const [contextDraft, setContextDraft] = useState("");
  const [job, setJob] = useState<DecodeBenchJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [loadingLast, setLoadingLast] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const benchPort = remoteTarget?.port ?? llmPort;
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [modelNotice, setModelNotice] = useState<string | null>(null);
  const selectionTargetRef = useRef<string | null>(null);
  const selectionTarget = JSON.stringify([sparkId, llmPort, remoteTarget?.host, remoteTarget?.port, remoteTarget?.tls]);
  const availableModels = useMemo(() => remoteTarget ? [] : [...new Set(
    (models ?? []).filter((id) => typeof id === "string" && id.trim().length > 0)
  )], [models, remoteTarget]);
  const hasModelDiscovery = !remoteTarget && models !== undefined;
  const modelSelectionValid = !hasModelDiscovery || (selectedModel !== null && availableModels.includes(selectedModel));

  useEffect(() => {
    if (!open) {
      selectionTargetRef.current = null;
      return;
    }
    const targetChanged = selectionTargetRef.current !== selectionTarget;
    selectionTargetRef.current = selectionTarget;
    if (!targetChanged && hasModelDiscovery && selectedModel && availableModels.includes(selectedModel)) return;
    const next = hasModelDiscovery
      ? (targetChanged && modelId && availableModels.includes(modelId) ? modelId : availableModels[0] ?? null)
      : remoteTarget ? null : modelId;
    if (targetChanged) setModelNotice(null);
    else if (hasModelDiscovery && selectedModel && selectedModel !== next) {
      setModelNotice(next ? t("decodeBench.modelSwitched", { model: next }) : t("decodeBench.noModelsServed"));
    } else setModelNotice(null);
    setSelectedModel(next);
  }, [open, selectionTarget, hasModelDiscovery, availableModels, modelId, remoteTarget, selectedModel]);

  const stopPoll = useCallback(() => {
    if (pollRef.current != null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const isRunning = job?.status === "running";
  // A saved run belongs to the model it ran against, which may not be the one loaded now (or any).
  const resultModelId = job?.config?.modelId || job?.results?.find((r) => r.model)?.model || modelId;

  const { mounted, visible } = useModalPresence(open);

  useEscape(onClose, open && !starting && !isPage);
  useBodyScrollLock(mounted && !isPage);

  const refreshHistory = useCallback(() => {
    void listDecodeBench(sparkId, benchPort)
      .then((data) => setHistory(data.history ?? []))
      .catch(() => {
        /* history is optional */
      });
  }, [sparkId, benchPort]);

  const applyJobConfig = useCallback((j: DecodeBenchJob) => {
    if (Array.isArray(j.config?.concurrencies) && j.config.concurrencies.length > 0) {
      setSelected([...j.config.concurrencies].sort((a, b) => a - b));
    }
    if (j.config?.maxTokens != null) {
      setMaxTokensDraft(String(j.config.maxTokens));
    }
    setContextDraft(j.config?.contextTokens ? String(j.config.contextTokens) : "");
    // Last-run type is shown on results; the picker always defaults to Structured
    // for the next Run. Only a still-running job pins the picker.
    if (j.status === "running" && j.config?.promptType) {
      setPromptType(normalizeDecodeBenchType(j.config.promptType));
    } else {
      setPromptType(DEFAULT_PROMPT_TYPE);
    }
  }, []);

  const startPolling = useCallback(
    (benchId: string) => {
      stopPoll();
      pollRef.current = setInterval(() => {
        void getDecodeBench(sparkId, benchId)
          .then((j) => {
            setJob(j);
            setError(null);
            if (j.status !== "running") {
              stopPoll();
              refreshHistory();
            }
          })
          .catch((err: Error) => {
            // Server --watch / restart can drop the in-memory job for a moment.
            // Recover via list, or show a clear interrupt message instead of a bare 404.
            void listDecodeBench(sparkId, benchPort)
              .then((data) => {
                if (data.active) {
                  setJob(data.active);
                  setError(null);
                  if (data.active.benchId !== benchId) {
                    startPolling(data.active.benchId);
                  } else if (data.active.status !== "running") {
                    stopPoll();
                  }
                  return;
                }
                const finished =
                  data.history?.find((j) => j.benchId === benchId) ||
                  (data.last?.benchId === benchId ? data.last : null);
                if (finished) {
                  setJob(finished);
                  setError(null);
                  stopPoll();
                  return;
                }
                setError(
                  err.message === "Benchmark not found"
                    ? t("bench.interrupted")
                    : err.message
                );
                stopPoll();
              })
              .catch(() => {
                setError(
                  err.message === "Benchmark not found"
                    ? t("bench.interrupted")
                    : err.message
                );
                stopPoll();
              });
          });
      }, 800);
    },
    [sparkId, benchPort, stopPoll, refreshHistory]
  );

  useEffect(() => {
    if (!open) {
      stopPoll();
      setPromptType(DEFAULT_PROMPT_TYPE);
      return;
    }
    setError(null);
    setJob(null);
    let cancelled = false;
    setLoadingLast(true);
    listDecodeBench(sparkId, benchPort)
      .then((data) => {
        if (cancelled) return;
        setHistory(data.history ?? []);
        if (data.active) {
          setJob(data.active);
          applyJobConfig(data.active);
          if (data.active.status === "running") {
            startPolling(data.active.benchId);
          }
          return;
        }
        if (data.last) {
          setJob(data.last);
          applyJobConfig(data.last);
          return;
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingLast(false);
      });
    return () => {
      cancelled = true;
      stopPoll();
    };
  }, [open, sparkId, benchPort, remoteTarget?.host, remoteTarget?.tls, stopPoll, startPolling, applyJobConfig]);

  useEffect(() => () => stopPoll(), [stopPoll]);

  useEffect(
    () => () => {
      if (copyResetRef.current != null) clearTimeout(copyResetRef.current);
    },
    []
  );

  const toggleConcurrency = (n: number) => {
    if (isRunning || starting) return;
    setSelected((prev) => {
      if (prev.includes(n)) {
        if (prev.length === 1) return prev;
        return prev.filter((x) => x !== n).sort((a, b) => a - b);
      }
      return [...prev, n].sort((a, b) => a - b);
    });
  };

  const startLockRef = useRef(false);

  // Page only: a run started from the Spark page's dialog (or another tab) shows up here too.
  useEffect(() => {
    if (!isPage) return;
    const t = setInterval(() => {
      if (pollRef.current != null || startLockRef.current) return;
      void listDecodeBench(sparkId, benchPort)
        .then((data) => {
          setHistory(data.history ?? []);
          if (data.active?.status === "running" && pollRef.current == null && !startLockRef.current) {
            setJob(data.active);
            applyJobConfig(data.active);
            startPolling(data.active.benchId);
          }
        })
        .catch(() => {
          /* next tick */
        });
    }, 5000);
    return () => clearInterval(t);
  }, [isPage, sparkId, benchPort, applyJobConfig, startPolling]);

  const handleStart = async () => {
    if (startLockRef.current) return;
    if (!modelSelectionValid) {
      setError(t("decodeBench.selectModel"));
      return;
    }
    if (selected.length === 0) {
      setError(t("decodeBench.selectConcurrency"));
      return;
    }
    const maxTokens = parseInt(maxTokensDraft.trim(), 10);
    if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 2048) {
      setError(t("decodeBench.maxTokensError"));
      return;
    }
    const temperature = Number(temperatureDraft.trim());
    if (temperatureDraft.trim() === "" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      setError(t("decodeBench.temperatureError"));
      return;
    }
    const contextTokens = parseContextDraft(contextDraft);
    if (contextTokens == null) {
      setError(
        t("decodeBench.contextError", {
          min: PREFILL_MIN_CONTEXT_SIZE,
          max: PREFILL_MAX_CONTEXT_SIZE.toLocaleString(),
        })
      );
      return;
    }
    startLockRef.current = true;
    setStarting(true);
    setError(null);
    setJob(null);
    try {
      const started = await startDecodeBench(sparkId, {
        port: benchPort,
        concurrencies: selected,
        maxTokens,
        modelId: selectedModel || undefined,
        promptType,
        temperature,
        thinking,
        ...(contextTokens > 0 ? { contextTokens } : {}),
        ...(remoteTarget
          ? { host: remoteTarget.host, tls: remoteTarget.tls }
          : {}),
      });
      setJob(started);
      startPolling(started.benchId);
      if (isPage) refreshHistory();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      startLockRef.current = false;
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!job || job.status !== "running") return;
    try {
      const j = await cancelDecodeBench(sparkId, job.benchId);
      setJob(j);
      startPolling(job.benchId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleNewRun = () => {
    stopPoll();
    setJob(null);
    setError(null);
  };

  const handleClear = async () => {
    if (!job || job.status === "running") return;
    setError(null);
    try {
      await clearDecodeBenchHistory(sparkId, benchPort);
      stopPoll();
      setJob(null);
      setHistory([]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleView = (id: string) => {
    const found = history.find((h) => h.benchId === id);
    if (!found || isRunning) return;
    stopPoll();
    setError(null);
    setJob(found);
  };

  if (!mounted) return null;

  const progressPct =
    job && job.progress.totalLevels > 0
      ? Math.round(
          ((job.progress.completedLevels + (job.status === "running" ? 0.35 : 0)) /
            job.progress.totalLevels) *
            100
        )
      : 0;

  const maxAgg = job ? Math.max(0, ...job.results.map(resultAgg)) : 0;
  const showConfig = (isPage || !job || job.status === "running") && !loadingLast;
  const showResults = job && job.status !== "running";

  const configNode = (
    <>
          {showConfig && (
            <section className="bench-sheet__section">
              {availableModels.length > 1 && (
                <div className="bench-field">
                  <div className="bench-field__head">
                    <label htmlFor="bench-model-select" className="bench-sheet__section-title">{t("bench.modelLabel")}</label>
                    <p className="bench-sheet__hint">{t("decodeBench.modelHint")}</p>
                  </div>
                  <select
                    id="bench-model-select"
                    className="bench-select"
                    value={selectedModel ?? ""}
                    disabled={isRunning || starting}
                    onChange={(e) => {
                      setSelectedModel(e.target.value);
                      setModelNotice(null);
                    }}
                  >
                    {availableModels.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                </div>
              )}
              {modelNotice && availableModels.length > 0 && <p className="bench-sheet__hint" role="status">{modelNotice}</p>}
              {hasModelDiscovery && availableModels.length === 0 && (
                <p className="bench-sheet__hint" role="status">{t("decodeBench.noModelsServed")}</p>
              )}
              <div className="bench-field">
                <div className="bench-field__head">
                  <h3 className="bench-sheet__section-title">{t("decodeBench.typeTitle")}</h3>
                  <p className="bench-sheet__hint">
                    {t("decodeBench.typeHint", {
                      hint: decodeTypeHint(t as unknown as (key: string) => string, promptType),
                      temperature: temperatureDraft || "?",
                      thinking: thinking ? t("decodeBench.thinkingOn") : t("decodeBench.thinkingOff"),
                    })}
                  </p>
                </div>
                <div
                  className="bench-type-grid"
                  role="radiogroup"
                  aria-label={t("decodeBench.typeAria")}
                >
                  {DECODE_BENCH_TYPE_META.map((meta) => {
                    const on = promptType === meta.id;
                    return (
                      <button
                        key={meta.id}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        title={decodeTypeHint(t as unknown as (key: string) => string, meta.id)}
                        disabled={isRunning || starting}
                        onClick={() => setPromptType(meta.id)}
                        className={`bench-conc-btn${on ? " is-on" : ""}`}
                      >
                        {decodeTypeLabel(t as unknown as (key: string) => string, meta.id)}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="bench-field">
                <div className="bench-field__head">
                  <h3 className="bench-sheet__section-title">{t("decodeBench.thinkingTitle")}</h3>
                  <p className="bench-sheet__hint">
                    {t("decodeBench.thinkingHint")}
                  </p>
                </div>
                <div className="bench-type-grid" role="radiogroup" aria-label={t("decodeBench.thinkingAria")}>
                  {([true, false] as const).map((on) => (
                    <button
                      key={String(on)}
                      type="button"
                      role="radio"
                      aria-checked={thinking === on}
                      disabled={isRunning || starting}
                      onClick={() => setThinking(on)}
                      className={`bench-conc-btn${thinking === on ? " is-on" : ""}`}
                    >
                      {on ? t("decodeBench.withThinking") : t("decodeBench.withoutThinking")}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bench-field">
                <div className="bench-field__head">
                  <label htmlFor="bench-temperature" className="bench-sheet__section-title">
                    {t("decodeBench.temperatureTitle")}
                  </label>
                  <p className="bench-sheet__hint">
                    {t("decodeBench.temperatureHint")}
                  </p>
                </div>
                <input
                  id="bench-temperature"
                  type="text"
                  inputMode="decimal"
                  className="bench-input"
                  size={6}
                  disabled={isRunning || starting}
                  value={temperatureDraft}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "" || /^\d*\.?\d{0,2}$/.test(raw)) setTemperatureDraft(raw);
                  }}
                />
              </div>

              <div className="bench-field">
                <div className="bench-field__head">
                  <h3 className="bench-sheet__section-title">{t("decodeBench.concurrencyTitle")}</h3>
                  <p className="bench-sheet__hint">
                    {t("decodeBench.concurrencyHint")}
                  </p>
                </div>
                <div className="bench-conc-grid">
                  {CONCURRENCY_OPTIONS.map((n) => {
                    const on = selected.includes(n);
                    return (
                      <button
                        key={n}
                        type="button"
                        disabled={isRunning || starting}
                        onClick={() => toggleConcurrency(n)}
                        className={`bench-conc-btn${on ? " is-on" : ""}`}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="bench-field">
                <div className="bench-field__head">
                  <label htmlFor="bench-start-context" className="bench-sheet__section-title">
                    {t("decodeBench.startContextTitle")}
                  </label>
                  <p className="bench-sheet__hint">
                    {t("decodeBench.startContextHint")}
                  </p>
                </div>
                <div className="bench-conc-grid" role="group" aria-label={t("decodeBench.startContextPresets")}>
                  {CONTEXT_PRESETS.map((n) => {
                    const on = (parseContextDraft(contextDraft) ?? -1) === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        disabled={isRunning || starting}
                        onClick={() => setContextDraft(n === 0 ? "" : String(n))}
                        className={`bench-conc-btn${on ? " is-on" : ""}`}
                      >
                        {n === 0 ? t("decodeBench.empty") : formatContextSize(n)}
                      </button>
                    );
                  })}
                </div>
                <div className="bench-custom-size">
                  <input
                    id="bench-start-context"
                    type="text"
                    inputMode="text"
                    placeholder={t("decodeBench.customPlaceholder")}
                    disabled={isRunning || starting}
                    value={contextDraft}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (/^\d*k?$/i.test(raw)) setContextDraft(raw);
                    }}
                    className="bench-input"
                    size={14}
                  />
                </div>
              </div>

              <div className="bench-field">
                <div className="bench-field__head">
                  <label htmlFor="bench-max-tokens" className="bench-sheet__section-title">
                    {t("decodeBench.maxTokensTitle")}
                  </label>
                  <p className="bench-sheet__hint">
                    {promptType === "structured" ? t("decodeBench.maxTokensHintStructured") : t("decodeBench.maxTokensHint")}
                  </p>
                </div>
                <input
                  id="bench-max-tokens"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  disabled={isRunning || starting}
                  value={maxTokensDraft}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "" || /^\d+$/.test(raw)) setMaxTokensDraft(raw);
                  }}
                  className="bench-input"
                  size={6}
                />
              </div>
            </section>
          )}

    </>
  );
  const progressNode = (
    <>
          {job && job.status === "running" && (
            <section className="bench-sheet__section">
              <div className="bench-progress">
                <div className="bench-progress__row">
                  <span className="bench-progress__status">
                    {t("decodeBench.progressStatus")}
                    {job.config?.promptType
                      ? ` · ${decodeTypeLabel(t as unknown as (key: string) => string, job.config.promptType)}`
                      : ""}
                    {job.progress.currentConcurrency != null
                      ? ` · ×${job.progress.currentConcurrency}`
                      : ""}
                    {contextLabel(job.config?.contextTokens)}
                  </span>
                  <span className="bench-progress__meta">
                    {job.progress.completedLevels}/{job.progress.totalLevels}
                    {job.durationMs != null ? ` · ${formatDuration(job.durationMs)}` : ""}
                  </span>
                </div>
                <div className="bench-progress__track">
                  <div
                    className="bench-progress__fill"
                    style={{ width: `${Math.min(100, progressPct)}%` }}
                  />
                </div>
                {job.progress.message ? (
                  <p className="bench-sheet__hint">{job.progress.message}</p>
                ) : null}
              </div>
              <LiveTps tps={job.progress.liveTps ?? liveTps} active />
              {job.results.length > 0 && (
                <div className="bench-results">
                  <div className="bench-results__caption">{t("bench.completedLevels")}</div>
                  {job.results.map((r) => (
                    <ResultRow key={r.concurrency} r={r} max={maxAgg} />
                  ))}
                </div>
              )}
            </section>
          )}

    </>
  );
  const resultsNode = (
    <>
          {showResults && (
            <section className="bench-sheet__section">
              <div className="bench-status-row">
                <span
                  className={`bench-status-pill bench-status-pill--${job.status}`}
                >
                  {statusLabel(t, job.status)}
                </span>
                <span className="bench-status-meta">
                  {decodeTypeLabel(t as unknown as (key: string) => string, job.config.promptType)} · {job.config.maxTokens} tok ·{" "}
                  {decodeBenchSamplingLabel(job.config, t)}
                  {contextLabel(job.config.contextTokens)} ·{" "}
                  {t("decodeBench.concLabel", { concurrency: job.config.concurrencies.join(", ") })}
                  {job.durationMs != null ? ` · ${formatDuration(job.durationMs)}` : ""}
                </span>
              </div>

              {job.error && <p className="bench-sheet__error">{job.error}</p>}

              {job.results.length > 0 && (
                <div className="bench-results bench-results--table">
                  <div className="bench-results__head" aria-hidden="true">
                    <span>{t("bench.loadColumn")}</span>
                    <span className="bench-results__head-speeds">
                      <span>{t("bench.aggregate")}</span>
                      <span>{t("bench.stream")}</span>
                    </span>
                  </div>
                  {job.results.map((r) => (
                    <ResultRow key={r.concurrency} r={r} max={maxAgg} />
                  ))}
                </div>
              )}

              {job.results.length > 0 && (
                <p className="bench-legend">
                  {t("decodeBench.legend")}
                </p>
              )}
            </section>
          )}
    </>
  );

  const copyButton =
    job && job.results.length > 0 ? (
      <BenchCopyButton
        text={buildShareText(job, resultModelId, t)}
        buildCard={() =>
          buildDecodeShareCard(job, {
            t: t as unknown as (key: string, vars?: Record<string, string | number>) => string,
            llmPort: benchPort,
            modelId: resultModelId,
            sparkName,
            engine,
            posture,
            remoteHost: remoteTarget?.host ?? null,
          })
        }
        kind="decode"
        shareImage={shareImage}
        onError={setError}
      />
    ) : null;

  if (isPage) {
    return (
      <PageLayout
        config={
          <>
            {loadingLast && !job && <p className="bench-sheet__hint">{t("bench.loadingLast")}</p>}
            {configNode}
          </>
        }
        runBar={
          isRunning ? (
            <button type="button" className="btn" onClick={() => void handleCancel()}>
              {t("bench.cancelRun")}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void handleStart()}
              disabled={starting || selected.length === 0}
            >
              {starting ? t("bench.starting") : t("bench.runBenchmark")}
            </button>
          )
        }
      >
        {error && <p className="bench-sheet__error">{error}</p>}
        {isRunning && <PageCard title={t("bench.pageProgress")}>{progressNode}</PageCard>}
        {showResults && (
          <PageCard
            title={t("bench.pageResults")}
            tools={
              <>
                {copyButton}
                {job.results.length > 0 && (
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => void handleClear()}
                    title={t("bench.clearTitle")}
                  >
                    {t("bench.clearHistory")}
                  </button>
                )}
              </>
            }
          >
            {resultsNode}
          </PageCard>
        )}
        {!job && !loadingLast && (
          <PageEmpty title={t("bench.noRunsTitle")}>
            {t("decodeBench.noRunHelp")}
          </PageEmpty>
        )}
        {history.length > 0 && (
          <PageCard title={t("bench.pageHistory", { count: history.length })}>
            {decodeBenchSamplingMixed(history.map((h) => h.config)) && (
              <p className="bench-sheet__hint" role="note">
                {t("decodeBench.mixedSettings")}
              </p>
            )}
            <HistoryTable
              rows={history.map(decodeHistoryRow)}
              activeId={job?.benchId ?? null}
              labelHeader={t("decodeBench.historyConcurrency")}
              onView={handleView}
              busy={isRunning || starting}
            />
          </PageCard>
        )}
      </PageLayout>
    );
  }

  const dialog = (
    <div className={`bench-overlay${visible ? " is-open" : ""}`} role="presentation">
      {/* Scrim — click to close when not running */}
      <button
        type="button"
        className="bench-overlay__scrim"
        aria-label={t("bench.closeDialog")}
        onClick={() => {
          if (!isRunning) onClose();
        }}
      />

      <div
        className="bench-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bench-title"
      >
        <header className="bench-sheet__header">
          <div className="bench-sheet__header-text">
            <h2 id="bench-title" className="bench-sheet__title">
              {t("decodeBench.title")}
            </h2>
            <p className="bench-sheet__subtitle">
              {remoteTarget
                ? formatLlmBaseUrl(remoteTarget)
                : t("bench.portLabel", { port: llmPort })}
              {resultModelId ? ` · ${resultModelId}` : ""}
            </p>
          </div>
          <BenchSwitcher active="decode" onSwitch={onSwitchBench} disabled={isRunning || starting} />
          <button
            type="button"
            className="bench-sheet__close"
            onClick={onClose}
            aria-label={t("shared.close")}
          >
            <XIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="bench-sheet__body">
          {loadingLast && !job && (
            <p className="bench-sheet__hint">{t("bench.loadingLast")}</p>
          )}

          {configNode}

          {error && <p className="bench-sheet__error">{error}</p>}

          {progressNode}

          {resultsNode}
        </div>

        <footer className="bench-sheet__footer">
          {job?.status === "running" ? (
            <button type="button" className="bench-btn bench-btn--ghost" onClick={() => void handleCancel()}>
              {t("bench.cancel")}
            </button>
          ) : job ? (
            <>
              {job.results.length > 0 && (
                <button
                  type="button"
                  className="bench-btn bench-btn--ghost"
                  onClick={() => void handleClear()}
                  title={t("bench.clearTitle")}
                >
                  {t("bench.clear")}
                </button>
              )}
              {job.results.length > 0 && (
                <BenchCopyButton
                  text={buildShareText(job, resultModelId, t)}
                  buildCard={() =>
                    buildDecodeShareCard(job, {
                      t: t as unknown as (key: string, vars?: Record<string, string | number>) => string,
                      llmPort: benchPort,
                      modelId: resultModelId,
                      sparkName,
                      engine,
                      posture,
                      remoteHost: remoteTarget?.host ?? null,
                    })
                  }
                  kind="decode"
                  shareImage={shareImage}
                  onError={setError}
                />
              )}
              <button type="button" className="bench-btn bench-btn--ghost" onClick={onClose}>
                {t("bench.done")}
              </button>
              <button type="button" className="bench-btn bench-btn--primary" onClick={handleNewRun}>
                {t("bench.runAgain")}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="bench-btn bench-btn--ghost" onClick={onClose}>
                {t("bench.close")}
              </button>
              <button
                type="button"
                className="bench-btn bench-btn--primary"
                onClick={() => void handleStart()}
                disabled={starting || selected.length === 0 || !modelSelectionValid}
              >
                {starting ? t("bench.starting") : t("bench.runBenchmark")}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
