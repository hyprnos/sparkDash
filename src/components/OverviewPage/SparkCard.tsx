import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SparkSnapshot } from "../../api/types";
import { resolveSparkRole } from "../../api/sparkRole";
import { usableHead } from "../../shared/sparkHead";
import { wakeSpark } from "../../api/client";
import { backendLabel } from "../../shared/llmBackends";
import { formatDiskSize, formatMb } from "../../shared/formatBytes";
import { Tag } from "../ui/Tag";
import { HealthChips, worstSeverity } from "../ui/HealthFindings";
import { AppLink } from "../ui/AppLink";
import { idToPath } from "../../constants";
import { VramBreakdownBar } from "../ui/VramBreakdownBar";
import { HEADROOM_THRESHOLDS_MB, computeVramBreakdown, memoryModelFor, type VramBreakdownContext } from "../../shared/vramBreakdown";
import { ImageIcon, PowerOnIcon } from "../ui/icons";
import { formatCtx } from "./fleetStats";
import { ModelLauncher } from "./ModelLauncher";

type Unit = "celsius" | "fahrenheit";

function toF(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

function fmtStorage(mb: number, unit: boolean): string {
  const val = mb >= 1024 ? mb / 1024 : mb;
  const label = mb >= 1024 ? "GB" : "MB";
  const s = val.toFixed(1).replace(/\.0$/, "");
  return unit ? `${s} ${label}` : s;
}

function Bar({
  label,
  caption,
  pct,
  color,
  title,
  sub,
}: {
  label: string;
  caption: string;
  pct: number;
  color: string;
  title?: string;
  /** Small line under the bar, e.g. available memory. */
  sub?: { label: string; value: string } | null;
}) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div>
      <div className="ov-lbl">
        <span title={title}>{label}</span>
        <b className="mono">{caption}</b>
      </div>
      <div className="ov-bar" role="progressbar" aria-label={label} aria-valuenow={p} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${p}%`, background: color }} />
      </div>
      {sub ? (
        <div className="ov-sub">
          <span>{sub.label}</span>
          <b className="mono">{sub.value}</b>
        </div>
      ) : null}
    </div>
  );
}

function SparkCardImpl({
  spark,
  headSpark,
  vramContext = null,
  temperatureUnit,
  onSelect,
}: {
  spark: SparkSnapshot;
  /** The head this worker serves for (workers only). */
  headSpark?: SparkSnapshot | null;
  /** Breakdown inputs (see `vramContextFor`); null keeps the plain VRAM bar. */
  vramContext?: VramBreakdownContext | null;
  temperatureUnit: Unit;
  onSelect?: (id: string) => void;
}) {
  const { t } = useTranslation("overview");
  const gpu = spark.metrics.gpu;
  const um = spark.metrics.unifiedMemory;
  const online = spark.online;
  const role = resolveSparkRole(spark);
  const llmList = Array.isArray(spark.metrics.llm) ? spark.metrics.llm : [];
  const llmIdx = llmList.findIndex((l) => l.available);
  const llm = llmIdx >= 0 ? llmList[llmIdx] : null;
  const [wakeMsg, setWakeMsg] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);

  const usage = gpu?.usage ?? 0;
  const tempRaw = gpu?.temperature ?? 0;
  const unitSuffix = temperatureUnit === "fahrenheit" ? "°F" : "°C";
  const fmtTemp = (c: number) => `${temperatureUnit === "fahrenheit" ? toF(c) : Math.round(c)}${unitSuffix}`;
  const tempMax = temperatureUnit === "fahrenheit" ? 212 : 100;
  const tempVal = temperatureUnit === "fahrenheit" ? toF(tempRaw) : tempRaw;
  const memPct = gpu?.vram?.percentage ?? um?.percentage ?? 0;
  const memUsed = gpu?.vram?.used ?? um?.used ?? 0;
  const memTotal = gpu?.vram?.total ?? um?.total ?? 0;
  const memAvail = gpu?.vram?.available ?? um?.available ?? 0;
  const vramAvailable = gpu?.metricAvailability?.vramUsed !== false && gpu?.metricAvailability?.vramTotal !== false;
  const breakdown = gpu && vramAvailable && vramContext ? computeVramBreakdown(gpu.vram, gpu.processes, vramContext) : null;
  const throttle = gpu?.throttle;
  const slowed = !!(throttle?.thermal || throttle?.hwSlowdown);
  const hot = slowed || tempRaw >= 80;

  const ringColor = hot ? "var(--color-warning)" : "var(--color-accent)";
  const memColor = memPct >= 90 ? "var(--color-danger)" : memPct >= 85 ? "var(--color-warning)" : "var(--color-info)";
  const tempColor = tempRaw > 80 ? "var(--color-danger)" : tempRaw >= 75 ? "var(--color-warning)" : "var(--color-success)";
  // A Spark's CPU runs much hotter than its GPU under the same load — on the GB10 the CPU
  // is the number that hits high temps first, so it belongs next to the GPU bars at a glance
  // instead of hiding behind a per-unit page visit.
  const cpuMetrics = spark.metrics.cpu ?? null;
  const cpuTempRaw = cpuMetrics && Number.isFinite(cpuMetrics.temperature) && cpuMetrics.temperature > 0 ? cpuMetrics.temperature : null;
  const cpuTempVal = cpuTempRaw === null ? 0 : temperatureUnit === "fahrenheit" ? toF(cpuTempRaw) : cpuTempRaw;
  const cpuTempColor = cpuTempRaw !== null && cpuTempRaw > 80 ? "var(--color-danger)" : cpuTempRaw !== null && cpuTempRaw >= 75 ? "var(--color-warning)" : "var(--color-success)";
  const cpuPower = cpuMetrics && (cpuMetrics.draw > 0 || cpuMetrics.tdp > 0) ? { draw: cpuMetrics.draw, tdp: cpuMetrics.tdp } : null;
  const cpuPowerPct = cpuPower && cpuPower.tdp > 0 ? (cpuPower.draw / cpuPower.tdp) * 100 : 0;
  const power = gpu?.power;
  const powerPct = power && power.limit > 0 ? (power.draw / power.limit) * 100 : 0;

  const rootDisk =
    spark.metrics.storage.find((d) => d.label === "/") ?? spark.metrics.storage.find((d) => d.device === "nvme0n1p2");

  const comfy = spark.comfyMonitoring ? spark.metrics?.comfy : undefined;
  const hermes = spark.hermes;

  const roleText = role === "head" ? t("spark.roleHead") : role === "worker" ? t("spark.roleWorker") : t("spark.roleStandalone");
  const roleTitle =
    role === "head"
      ? t("spark.roleHeadTitle")
      : role === "worker"
        ? spark.workerLabel?.trim()
          ? t("spark.roleWorkerTitleLabel", { label: spark.workerLabel.trim() })
          : t("spark.roleWorkerTitle")
        : spark.llmMonitoring === false
          ? t("spark.roleStandaloneOff")
          : t("spark.roleStandaloneTitle");

  async function onWake() {
    setWaking(true);
    setWakeMsg(null);
    try {
      const res = await wakeSpark(spark.id);
      setWakeMsg(res.success ? t("spark.wakeSent") : res.error || res.message || t("spark.wakeFailed"));
    } catch (err) {
      setWakeMsg(err instanceof Error ? err.message : t("spark.wakeFailed"));
    } finally {
      setWaking(false);
    }
  }

  // Model box content: workers show their label, others the live backend + model.
  let modelEyebrowRight: string | null = null;
  let modelText: string | null = null;
  let modelTitle: string | undefined;
  const headName = headSpark?.name ?? null;
  // An offline head's last LLM reading is stale: do not present it as the worker's live model.
  const liveHead = usableHead(headSpark);
  const headLlmList = Array.isArray(liveHead?.metrics.llm) ? liveHead.metrics.llm : [];
  const headLlm = headLlmList.find((l) => l.available) ?? null;
  if (role === "worker") {
    // Prefer the head's live model; fall back to the configured / mirrored worker label.
    const label = headLlm?.modelId || spark.workerLabel?.trim() || spark.workerDerivedLabel?.trim() || null;
    modelEyebrowRight = headLlm ? formatCtx(headLlm.contextLength) : null;
    modelText = label ?? (headName ? t("spark.noModelOnHead") : t("spark.worker"));
    modelTitle = headName
      ? t("spark.modelWorkerTitle", { model: label ?? t("spark.noModel"), head: headName })
      : t("spark.modelWorkerTitleBare", { model: label ?? t("spark.distributed") });
  } else if (llm) {
    // The engine name lives in the tooltip; the row itself is just model + context.
    const engine = backendLabel(llm.backend) ?? llm.backend ?? "LLM";
    modelEyebrowRight = formatCtx(llm.contextLength);
    modelText = llm.modelId ?? t("spark.unknown");
    modelTitle = llm.modelId ? `${llm.modelId} · ${engine}` : engine;
  }
  // Idle Spark (nothing serving): the launcher block fills the free space instead.
  // Memory or compute in use while nothing serves yet: a model is most likely still loading.
  // When nvidia-smi names the processes holding the GPU, say so: it may be a server sparkDash does not
  // monitor (add its port under "+ Add LLM port"), not a model that is still starting.
  const gpuHolders = (gpu?.processes ?? [])
    .filter((p) => p.vramMB > 0)
    .slice(0, 3)
    .map((p) => `${p.name} (${formatMb(p.vramMB)})`);
  const loadingHint =
    !llm && (memUsed >= 2048 || usage >= 10)
      ? t("spark.loadingHint", {
          holders: gpuHolders.length > 0 ? t("spark.loadingHolders", { names: gpuHolders.join(", ") }) : "",
          memory: formatMb(memUsed),
          usage: Math.round(usage),
        })
      : null;
  const showLauncher = role !== "worker" && !llm && spark.llmMonitoring !== false && spark.platform !== "windows";

  const showTps = role !== "worker" && !!llm;
  const isStrata = llm?.backend === "strata";
  // Engines that report requests (TensorFold, Strata, …) used to hide their parallelism behind
  // "N running": a unit set to --parallel 4 and one set to 8 read the same. Name the capacity too.
  const parallel = llm && llm.slotsTotal > 0 ? llm.slotsTotal : null;
  const llmChip = llm
    ? llm.requestsRunning != null
      ? `${t("spark.runningChip", {
          running: llm.requestsRunning,
          queue: llm.requestsWaiting == null ? t("spark.queueUnknown") : t("spark.queued", { count: llm.requestsWaiting }),
        })}${parallel != null ? t("spark.slotsSuffix", { count: parallel }) : ""}`
      : llm.slotsTotal > 0
        ? t("spark.slotsChip", { active: llm.slotsActive ?? "?", total: llm.slotsTotal })
        : null
    : null;
  const llmChipTitle = parallel != null && llm?.requestsRunning != null ? t("spark.parallelTitle", { count: parallel }) : undefined;

  const chips = (
    <div className="ov-chips">
      {online && throttle && slowed ? (
        <Tag tone="warn" title={throttle.detail || t("spark.throttleTitle")}>
          {throttle.thermal ? t("spark.throttleThermal") : t("spark.throttleHw")}
          {throttle.smClockMHz ? t("spark.smClock", { ghz: (throttle.smClockMHz / 1000).toFixed(1) }) : ""}
        </Tag>
      ) : null}
      {online && throttle?.clockCapMHz != null ? (
        <Tag title={t("spark.capTitle")}>
          {t("spark.cap", { ghz: (throttle.clockCapMHz / 1000).toFixed(1) })}
        </Tag>
      ) : null}
      {online && llmChip ? <Tag tone={(llm?.requestsRunning ?? llm?.slotsActive ?? 0) > 0 ? "good" : "neutral"} title={llmChipTitle}>{llmChip}</Tag> : null}
      {comfy !== undefined || spark.comfyMonitoring ? (
        !comfy?.available ? (
          <Tag title={t("spark.comfyUnreachableTitle")}>{t("spark.comfy")}</Tag>
        ) : (comfy.queueRunning ?? 0) > 0 ? (
          <Tag tone="info" title={comfy.activeJob?.title ? t("spark.comfyRunningTitle", { title: comfy.activeJob.title }) : t("spark.comfyJobTitle")}>
            <ImageIcon className="h-3.5 w-3.5" />
            {comfy.activeJob?.title ? `ComfyUI · ${comfy.activeJob.title}` : t("spark.comfyRunning")}
            {comfy.progress?.percent != null ? ` ${Math.round(comfy.progress.percent)}%` : ""}
          </Tag>
        ) : (comfy.queuePending ?? 0) > 0 ? (
          <Tag tone="warn" title={t("spark.comfyQueueTitle", { count: comfy.queuePending })}>{t("spark.comfyQueue", { count: comfy.queuePending })}</Tag>
        ) : (
          <Tag title={t("spark.comfyIdleTitle")}>{t("spark.comfyIdle")}</Tag>
        )
      ) : null}
      {hermes?.monitoring && hermes.status === "running" ? <Tag tone="info">{t("spark.hermesUpdating")}</Tag> : null}
      {hermes?.monitoring && hermes.status !== "running" && hermes.updateAvailable ? (
        <Tag tone="acc" title={t("spark.hermesAvailableTitle")}>{t("spark.hermesAvailable")}</Tag>
      ) : null}
      {!online ? <Tag>{t("spark.offline")}</Tag> : null}
    </div>
  );

  return (
    <div className={`overview-card ov-sc ${online ? "" : "is-off"} ${hot && online ? "is-hot" : ""} ${online && worstSeverity(spark.health) ? `is-health-${worstSeverity(spark.health)}` : ""} ${onSelect ? "is-link" : ""}`}>
      <div className="ov-sc__head">
        <i className={`sdot ${!online ? "sdot--off" : hot || worstSeverity(spark.health) ? "sdot--warn" : ""}`} aria-label={online ? t("spark.onlineAria") : t("spark.offlineAria")} />
        <h3 className="ov-sc__name">
          {onSelect ? (
            // Stretched link: this button's ::after covers the whole card (overview.css), so the card
            // is clickable without being a button that contains buttons.
            <AppLink href={idToPath(spark.id)} className="ov-sc__link" onNavigate={() => onSelect(spark.id)} title={t("spark.openSpark", { name: spark.name })}>
              {spark.name}
            </AppLink>
          ) : (
            spark.name
          )}
        </h3>
        <Tag className="tag--role" tone={role === "head" ? "acc" : "neutral"} title={roleTitle}>{roleText}</Tag>
        {spark.lanIp ? <span className="ov-sc__ip mono">{spark.lanIp}</span> : null}
      </div>

      {online ? <HealthChips findings={spark.health} /> : null}

      {!online || !gpu ? (
        <div className="ov-sc__off">
          <span>{online ? t("spark.waitingMetrics") : t("spark.unreachable")}</span>
          {!online && spark.kind === "host" ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={waking}
              onClick={() => void onWake()}
            >
              <PowerOnIcon className="h-3.5 w-3.5" />
              {t("spark.wakeUp")}
            </button>
          ) : null}
          {wakeMsg ? <span className="ov-sc__msg">{wakeMsg}</span> : null}
          {chips}
        </div>
      ) : (
        <>
          <div className="ov-sc__body">
            <div className="ov-sc__stats">
              {breakdown ? (
                <VramBreakdownBar
                  label={breakdown.systemMB != null ? t("spark.unifiedMemory") : t("spark.vram")}
                  breakdown={breakdown}
                  showLegend
                />
              ) : (
                <Bar
                  label={gpu.vram?.total ? t("spark.vram") : t("spark.unifiedMemory")}
                  caption={vramAvailable && memTotal > 0 ? `${fmtStorage(memUsed, false)} / ${fmtStorage(memTotal, true)}` : "—"}
                  pct={vramAvailable ? memPct : 0}
                  color={memColor}
                  sub={memTotal > 0 && memAvail > 0 ? { label: t("spark.available"), value: formatMb(memAvail) } : null}
                />
              )}
              <Bar label={t("spark.gpu")} caption={gpu.metricAvailability?.usage === false ? "—" : `${Math.round(usage)}%`} pct={gpu.metricAvailability?.usage === false ? 0 : usage} color={ringColor} />
              {spark.kind === "host" && spark.metrics.ram?.total ? (
                <Bar
                  label={t("spark.ram")}
                  caption={`${fmtStorage(spark.metrics.ram.used, false)} / ${fmtStorage(spark.metrics.ram.total, true)}`}
                  pct={(spark.metrics.ram.used / spark.metrics.ram.total) * 100}
                  color="var(--color-info)"
                />
              ) : null}
              <Bar label={t("spark.gpuTemp")} caption={gpu.metricAvailability?.temperature === false ? "—" : fmtTemp(tempRaw)} pct={gpu.metricAvailability?.temperature === false ? 0 : (tempVal / tempMax) * 100} color={tempColor} />
              <Bar
                label={t("spark.gpuPower")}
                caption={gpu.metricAvailability?.powerDraw === false ? "—" : `${power?.draw ?? 0} / ${gpu.metricAvailability?.powerLimit === false ? "—" : power?.limit ?? 0} W`}
                pct={gpu.metricAvailability?.powerDraw === false ? 0 : powerPct}
                color="var(--color-violet)"
              />
              {cpuTempRaw !== null ? (
                <Bar
                  label={t("spark.cpuTemp")}
                  title={cpuMetrics?.temperatureLabel ? t("spark.sensorTitle", { label: cpuMetrics.temperatureLabel }) : undefined}
                  caption={fmtTemp(cpuTempRaw)}
                  pct={(cpuTempVal / tempMax) * 100}
                  color={cpuTempColor}
                />
              ) : null}
              {cpuPower ? <Bar label={t("spark.cpuPower")} caption={`${cpuPower.draw} / ${cpuPower.tdp} W`} pct={cpuPowerPct} color="var(--color-violet)" /> : null}
            </div>
          </div>
          {showLauncher ? <ModelLauncher spark={spark} onOpen={onSelect} busy={loadingHint} busyHolders={gpuHolders.length > 0} freeMb={memTotal > 0 ? memAvail : null} lowFreeMb={HEADROOM_THRESHOLDS_MB[memoryModelFor(spark.kind)].low} /> : null}
          {role === "worker" ? (
            <div className="ov-launch ov-launch--worker">
              <div className="eyebrow">{t("spark.workerOf")}</div>
              {headSpark ? (
                <AppLink
                  href={idToPath(headSpark.id)}
                  className="ov-launch__head"
                  onNavigate={() => onSelect?.(headSpark.id)}
                  title={t("spark.openSpark", { name: headSpark.name })}
                >
                  <i className={`sdot ${headSpark.online ? "" : "sdot--off"}`} aria-hidden />
                  {headSpark.name}
                </AppLink>
              ) : (
                <div className="ov-launch__title">{t("spark.headNotSet")}</div>
              )}
              <div className="ov-launch__hint">
                {headLlm
                  ? t("spark.headDecode", {
                      backend: backendLabel(headLlm.backend) ?? headLlm.backend ?? "LLM",
                      tps:
                        headLlm.measurementValid === false || headLlm.generationTpsKnown === false
                          ? "—"
                          : headLlm.generationTps.toFixed(1),
                      perStream: headLlm.perStreamTps != null ? t("spark.perStream", { tps: headLlm.perStreamTps.toFixed(1) }) : "",
                      prefill:
                        headLlm.perStreamPrefillTps != null
                          ? t("spark.prefillPerRequest", { count: Math.round(headLlm.perStreamPrefillTps).toLocaleString() })
                          : "",
                    })
                  : headSpark
                    ? headSpark.online
                      ? t("spark.noModelOnHeadShort")
                      : t("spark.headOffline")
                    : t("spark.pickHead")}
              </div>
            </div>
          ) : null}
          {showTps && llm ? (
            <div className="ov-tps">
              <div title={isStrata ? t("spark.strataDecodeTitle") : undefined}>
                <div className="eyebrow">{t("spark.decode")}</div>
                {llm.measurementValid === false || llm.generationTpsKnown === false ? (
                  <div className="big-num ov-tps__num" title={llm.measurementError ?? (llm.generationTpsKnown === false ? t("spark.rateUnavailable") : t("spark.statsUnreadable"))}>—</div>
                ) : isStrata && llm.decodeActive && llm.generationTps <= 0 ? (
                  <div className="big-num ov-tps__num ov-tps__num--live">
                    <span className="ov-tps__dots" aria-hidden />
                    <small>{t("spark.decoding")}</small>
                  </div>
                ) : (
                  <div className="big-num ov-tps__num">{llm.generationTps.toFixed(1)}<small>tok/s</small></div>
                )}
                {isStrata && llm.generationTpsSource === "slot-mean" && <small className="text-muted">{t("spark.activeSlotMean")}</small>}
                {llm.measurementValid !== false && llm.perStreamTps != null && (
                  <small className="text-muted" title={t("spark.perStreamTitle")}>
                    {t("spark.perStreamTps", { tps: llm.perStreamTps.toFixed(1) })}
                  </small>
                )}
              </div>
              <div title={isStrata ? t("spark.strataPrefillTitle") : undefined}>
                <div className="eyebrow">{t("spark.prefill")}</div>
                {llm.measurementValid === false ? (
                  <div className="big-num ov-tps__num" title={llm.measurementError ?? t("spark.statsUnreadable")}>—</div>
                ) : llm.prefillActive && llm.prefillTps <= 0 ? (
                  <div className="big-num ov-tps__num ov-tps__num--live" title={isStrata ? t("spark.promptProcessingStrata") : t("spark.promptProcessing")}>
                    <span className="ov-tps__dots" aria-hidden />
                    <small>{t("spark.prefilling")}</small>
                  </div>
                ) : (
                  <div className="big-num ov-tps__num">{llm.prefillTpsKnown === false ? "—" : Math.round(llm.prefillTps).toLocaleString()}<small>tok/s</small></div>
                )}
                {llm.measurementValid !== false && llm.perStreamPrefillTps != null && (
                  <small className="text-muted" title={t("spark.perStreamPrefillTitle")}>
                    {t("spark.perStreamPrefill", { count: Math.round(llm.perStreamPrefillTps).toLocaleString() })}
                  </small>
                )}
                {isStrata && llm.prefillTps > 0 && <small className="text-muted">{t("spark.lastReportedMean")}</small>}
              </div>
            </div>
          ) : null}
          {llm?.runtimePhase && <div className="ov-launch__hint" title={t("spark.runtimeTitle")}>
            {llm.runtimePhase.replaceAll("-", " ")} · {t("spark.runWait", { running: llm.requestsRunning ?? "—", waiting: llm.requestsWaiting ?? "—" })}
            {llm.pendingPrefillTokens != null ? t("spark.pendingTokens", { tokens: llm.pendingPrefillTokens.toLocaleString() }) : ""}
          </div>}
          {chips}
          {rootDisk ? (
            <div className="ov-foot">
              <div className="ov-kv">
                <span>{t("spark.storage")}</span>
                <b
                  className="mono"
                  title={t("spark.storageTitle", {
                    used: fmtStorage(rootDisk.used, true),
                    total: fmtStorage(rootDisk.total, true),
                    percent: Math.round(rootDisk.percentage),
                  })}
                >
                  {formatDiskSize(rootDisk.used)} / {formatDiskSize(rootDisk.total)}
                </b>
              </div>
              <div className="ov-kv">
                <span>{t("spark.storageAvailable")}</span>
                <b className="mono">{fmtStorage(rootDisk.available ?? Math.max(0, rootDisk.total - rootDisk.used), true)}</b>
              </div>
            </div>
          ) : null}
          {modelText ? (
            <div className="ov-modelrow" title={modelTitle}>
              <code>{modelText}</code>
              {modelEyebrowRight ? <span className="ov-modelrow__ctx">{modelEyebrowRight}</span> : null}
            </div>
          ) : (
            // Nothing to show, but keep the row's height so Storage lines up across the cards.
            <div className="ov-modelrow ov-modelrow--empty" aria-hidden="true">
              <code>{"\u00a0"}</code>
            </div>
          )}
          {online && role !== "worker" && [...new Set([
            ...llmList.filter((entry) => entry.available).flatMap((entry) => entry.models?.length ? entry.models : entry.modelId ? [entry.modelId] : []),
            ...(spark.metrics.residentModels ?? []).map((entry) => entry.modelId),
          ])].filter((name) => name !== modelText).map((name) => (
            <div className="ov-modelrow" key={name} title={t("spark.loadedTitle", { name })}>
              <code>{name}</code>
              <span className="ov-modelrow__ctx">{t("spark.loaded")}</span>
            </div>
          ))}
        </>
      )}

    </div>
  );
}

/** Memoised: the Overview re-renders on every keystroke in its search and on each snapshot. */
export const SparkCard = memo(SparkCardImpl);