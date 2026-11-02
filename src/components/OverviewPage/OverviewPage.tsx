import { SwitchMonitorPanel } from "../NetworkSwitches/SwitchMonitorPanel";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AlertInstance, SparkSnapshot } from "../../api/types";
import { isWorkerSpark } from "../../api/sparkRole";
import { updateAllHermes, wakeAllSparks } from "../../api/client";
import { ShutdownAll } from "../ShutdownAll";
import { FleetEnergyCard } from "./FleetEnergyCard";
import { FleetAlertStrip } from "./FleetAlertStrip";
import { FleetTokenTotals } from "./FleetTokenTotals";
import { InferenceTrafficCard } from "./InferenceTrafficCard";
import { FleetKpis, type KpiVisibility } from "./FleetKpis";
import { ACTIVITY_ID, ENERGY_ID, TOKENS_ID } from "../../constants";
import { SparkCard } from "./SparkCard";
import { ActivityFeed } from "./ActivityFeed";
import { ActivityIcon, PowerOnIcon, RotateIcon } from "../ui/icons";
import { formatMb } from "../../shared/formatBytes";
import { vramContextFor } from "../../shared/vramBreakdown";
import { makeHeadResolver } from "../../shared/sparkHead";
import "../../styles/overview.css";

interface OverviewPageProps {
  sparks: SparkSnapshot[];
  hideOffline?: boolean;
  hideWorkers?: boolean;
  showFleetEnergy?: boolean;
  /** Opt-in server capability; absent sources add no card or polling. */
  showInferenceActivity?: boolean;
  showFleetExceptions?: boolean;
  /** Alert notifications on: the exceptions strip lists `serverAlerts` instead of deriving its own. */
  alertsEnabled?: boolean;
  serverAlerts?: AlertInstance[] | null;
  showOverviewSearch?: boolean;
  /** Overview LLM token totals card (cumulative tokens per model). */
  showLlmTokenTotals?: boolean;
  /** Recent activity card. On by default. */
  showActivityFeed?: boolean;
  /** Which KPI tiles are shown; a missing key means shown. */
  kpis?: KpiVisibility;
  /** VRAM bar split by engine / system / free, judged by headroom. On by default. */
  showVramBreakdown?: boolean;
  temperatureUnit?: "celsius" | "fahrenheit";
  onSelectSpark?: (id: string) => void;
  /** Open a dedicated page (Token totals, Fleet energy, Activity). */
  onNavigate?: (id: string) => void;
}

export function OverviewPage({
  sparks,
  hideOffline = false,
  hideWorkers = false,
  showFleetEnergy = true,
  showInferenceActivity = false,
  showFleetExceptions = false,
  alertsEnabled = false,
  serverAlerts = null,
  showOverviewSearch = false,
  showLlmTokenTotals = true,
  showActivityFeed = true,
  kpis,
  showVramBreakdown = true,
  temperatureUnit = "celsius",
  onSelectSpark,
  onNavigate,
}: OverviewPageProps) {
  const { t } = useTranslation("overview");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "offline" | "issues">("all");
  const withoutWorkers = useMemo(
    () => (hideWorkers ? sparks.filter((s) => !isWorkerSpark(s)) : sparks),
    [sparks, hideWorkers]
  );
  // Stable between renders that change nothing it depends on (a keystroke elsewhere, a dialog).
  const visibleSparks = useMemo(
    () =>
      withoutWorkers.filter((spark) => {
        if (hideOffline && !spark.online) return false;
        if (showOverviewSearch && query && !spark.name.toLowerCase().includes(query.toLowerCase())) return false;
        if (showOverviewSearch && statusFilter === "online" && !spark.online) return false;
        if (showOverviewSearch && statusFilter === "offline" && spark.online) return false;
        if (showOverviewSearch && statusFilter === "issues" && spark.online && !spark.metrics.storage.some((disk) => disk.percentage >= 90)) return false;
        return true;
      }),
    [withoutWorkers, hideOffline, showOverviewSearch, query, statusFilter]
  );
  // Head lookup and VRAM contexts for the whole fleet in one pass (not one scan per card).
  const cardContext = useMemo(() => {
    const resolveHead = makeHeadResolver(sparks);
    const byId = new Map<string, { head: SparkSnapshot | null; vram: ReturnType<typeof vramContextFor> | null }>();
    for (const spark of sparks) {
      byId.set(spark.id, {
        head: resolveHead(spark),
        vram: showVramBreakdown ? vramContextFor(spark, sparks, resolveHead) : null,
      });
    }
    return byId;
  }, [sparks, showVramBreakdown]);
  const hiddenWorkerCount = hideWorkers ? sparks.filter(isWorkerSpark).length : 0;
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchMsg, setBatchMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  /** Spark ids we started a batch Hermes update on; drives the live progress bar. */
  const [batchRun, setBatchRun] = useState<string[] | null>(null);

  const onlineShutdownCount = sparks.filter((s) => s.online).length;
  const hermesMonitoredCount = sparks.filter((s) => s.hermes?.monitoring).length;
  const hermesPendingUpdateCount = sparks.filter((s) => s.hermes?.updateAvailable === true).length;

  // Live batch progress — counted from WS snapshots, not from the one-shot HTTP response.
  const batchProg = (() => {
    if (!batchRun || batchRun.length === 0) return null;
    let done = 0;
    let failed = 0;
    for (const id of batchRun) {
      const h = sparks.find((s) => s.id === id)?.hermes;
      if (!h) continue;
      if (h.status === "error") {
        done += 1;
        failed += 1;
      } else if (h.status === "success" || h.finishedAt != null) {
        done += 1;
      }
    }
    return { total: batchRun.length, done, failed };
  })();

  // Once every started update has settled (success/error), dismiss the progress bar.
  useEffect(() => {
    if (!batchRun || batchRun.length === 0) return;
    const settled = batchRun.reduce((n, id) => {
      const h = sparks.find((s) => s.id === id)?.hermes;
      if (!h) return n;
      return n + (h.status === "success" || h.status === "error" || h.finishedAt != null ? 1 : 0);
    }, 0);
    if (settled === batchRun.length) {
      const t = setTimeout(() => setBatchRun(null), 6000);
      return () => clearTimeout(t);
    }
  }, [batchRun, sparks]);

  async function handleUpdateAllHermes() {
    if (hermesMonitoredCount === 0) return;
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await updateAllHermes();
      const started = res.results.filter((r) => r.started);
      const skipped = res.results.filter((r) => r.skipped).length;
      const failed = res.results.filter((r) => !r.ok && !r.skipped).length;
      const parts = [
        started.length === 1 ? t("header.batchStartedOne", { count: started.length }) : t("header.batchStartedMany", { count: started.length }),
      ];
      if (skipped) parts.push(t("header.batchSkipped", { count: skipped }));
      if (failed) parts.push(t("header.batchFailed", { count: failed }));
      setBatchMsg({
        text: parts.join(", "),
        tone: failed === 0 ? "ok" : "err",
      });
      // Merge with any in-flight batch instead of replacing (server may skip
      // already-running jobs, which must not clear a live progress bar).
      setBatchRun((prev) => {
        const ids = started.map((r) => r.id);
        if (ids.length === 0) return prev;
        return [...new Set([...(prev ?? []), ...ids])];
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : t("header.batchHermesFailed"),
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  async function handleWakeAll() {
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await wakeAllSparks();
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.filter((r) => !r.ok).length;
      setBatchMsg({
        text: fail === 0 ? t("header.wakeSent", { count: ok }) : t("header.wakePartial", { count: ok, failed: fail }),
        tone: fail === 0 ? "ok" : "err",
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : t("header.batchWakeFailed"),
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  if (withoutWorkers.length === 0 || (hideOffline && withoutWorkers.every((spark) => !spark.online))) {
    const allWorkersHidden = hideWorkers && sparks.length > 0 && withoutWorkers.length === 0;
    const allOffline = hideOffline && withoutWorkers.length > 0;
    const title = allWorkersHidden
      ? t("empty.workersHiddenTitle")
      : allOffline
        ? t("empty.allOfflineTitle")
        : t("empty.noneTitle");
    const detail = allWorkersHidden
      ? t("empty.workersHiddenDetail")
      : allOffline
        ? t("empty.allOfflineDetail")
        : t("empty.noneDetail");
    return (
      <div className="panel ov mx-auto mt-16 max-w-md p-8 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <ActivityIcon className="h-5 w-5" />
        </div>
        <h2 className="text-sm font-semibold text-text-strong">{title}</h2>
        <p className="mt-1 text-xs text-muted">{detail}</p>
      </div>
    );
  }

  const onlineCount = visibleSparks.filter((s) => s.online).length;
  const memTotalMb = sparks.reduce((n, s) => n + (s.metrics.gpu?.vram?.total || s.metrics.unifiedMemory?.total || 0), 0);

  return (
    <div className="ov">
      <div className="ov-title">
        <div>
          <h1>{t("header.title")}</h1>
          <div className="ov-meta">
            {sparks.length} {sparks.length === 1 ? t("header.sparkOne") : t("header.sparkMany")}
            <span className="tag tag--good">{t("header.online", { online: onlineCount, total: visibleSparks.length })}</span>
            {memTotalMb > 0 ? <span>{t("header.memory", { size: formatMb(memTotalMb) })}</span> : null}
            {hiddenWorkerCount > 0 ? (
              <span>
                {hiddenWorkerCount === 1
                  ? t("header.workerHiddenOne", { count: hiddenWorkerCount })
                  : t("header.workerHiddenMany", { count: hiddenWorkerCount })}
              </span>
            ) : null}
          </div>
        </div>
        <div className="ov-btns">
          {batchMsg && (
            <span className={`ov-batchmsg ${batchMsg.tone === "ok" ? "is-ok" : "is-err"}`} role="status">
              {batchMsg.text}
            </span>
          )}
          {batchProg && (
            <div className="ov-prog">
              <span className="ov-prog__label">
                <RotateIcon className="h-3 w-3" />
                {t("header.updating", { done: batchProg.done, total: batchProg.total })}
                {batchProg.failed > 0 && <span className="text-danger">({t("header.failedCount", { count: batchProg.failed })})</span>}
                <button type="button" onClick={() => setBatchRun(null)} aria-label={t("header.dismissProgress")} title={t("header.dismiss")} className="ov-prog__x">
                  {"\u2715"}
                </button>
              </span>
              <div className="ov-prog__track">
                <div
                  className={`ov-prog__fill ${batchProg.failed > 0 ? "is-err" : ""}`}
                  style={{ width: `${batchProg.total > 0 ? Math.round((batchProg.done / batchProg.total) * 100) : 0}%` }}
                />
              </div>
            </div>
          )}
          {sparks.length > 0 && (
            <>
              {hermesMonitoredCount > 0 && (
                <button
                  type="button"
                  onClick={() => void handleUpdateAllHermes()}
                  disabled={batchLoading}
                  title={t("header.updateHermesTitle")}
                  className={`btn ${hermesPendingUpdateCount > 0 ? "ov-btn--pending" : ""}`}
                >
                  <RotateIcon className="h-3.5 w-3.5" />
                  {t("header.updateHermes")}
                  {hermesPendingUpdateCount > 0 && (
                    <span className="ov-badge" title={t("header.updateBadgeTitle", { count: hermesPendingUpdateCount })}>
                      {hermesPendingUpdateCount}
                    </span>
                  )}
                </button>
              )}
              {sparks.some((spark) => spark.kind === "host") && (
                <button
                  type="button"
                  onClick={() => void handleWakeAll()}
                  disabled={batchLoading}
                  title={t("header.wakeAllTitle")}
                  className="btn"
                >
                  <PowerOnIcon className="h-3.5 w-3.5" />
                  {t("header.wakeAll")}
                </button>
              )}
              <ShutdownAll sparks={sparks} className="ov-shutdown" />
            </>
          )}
        </div>
      </div>

      <FleetAlertStrip
        sparks={sparks}
        onSelect={onSelectSpark}
        showExceptions={showFleetExceptions}
        temperatureUnit={temperatureUnit}
        alertsEnabled={alertsEnabled}
        serverAlerts={serverAlerts}
      />

      {showOverviewSearch ? (
        <div className="ov-search" role="search" aria-label={t("search.region")}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("search.placeholder")}
            aria-label={t("search.label")}
            className="ov-input"
          />
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
            aria-label={t("search.statusAria")}
            className="ov-input ov-input--select"
          >
            <option value="all">{t("search.all")}</option>
            <option value="online">{t("search.online")}</option>
            <option value="offline">{t("search.offline")}</option>
            <option value="issues">{t("search.issues")}</option>
          </select>
        </div>
      ) : null}

      <div className="ov-grid">
        <div className="ov-sparks" data-count={visibleSparks.length}>
          {visibleSparks.length === 0 && (
            <p className="panel ov-empty">{t("search.noMatch")}</p>
          )}
          {visibleSparks.map((spark) => {
            const ctx = cardContext.get(spark.id);
            return (
              <SparkCard
                key={spark.id}
                spark={spark}
                headSpark={ctx?.head ?? null}
                vramContext={ctx?.vram ?? null}
                temperatureUnit={temperatureUnit}
                onSelect={onSelectSpark}
              />
            );
          })}
        </div>
<FleetKpis sparks={sparks} snapshotKey={sparks} show={kpis} />
        <SwitchMonitorPanel />
        {showFleetEnergy || showLlmTokenTotals || showActivityFeed || showInferenceActivity ? (
        <div className="ov-side">
          {showInferenceActivity ? <InferenceTrafficCard /> : null}
          {showFleetEnergy ? <FleetEnergyCard nodeCount={sparks.length} nodeNames={Object.fromEntries(sparks.map((s) => [s.id, s.name]))} onOpenDetails={onNavigate ? () => onNavigate(ENERGY_ID) : undefined} /> : null}
          {showLlmTokenTotals ? <FleetTokenTotals onOpenDetails={onNavigate ? () => onNavigate(TOKENS_ID) : undefined} /> : null}
          {showActivityFeed ? (
            <section className="panel ov-card" aria-label={t("activity.title")}>
              <ActivityFeed limit={6} onSelectSpark={onSelectSpark} onViewAll={onNavigate ? () => onNavigate(ACTIVITY_ID) : undefined} />
            </section>
          ) : null}
        </div>
        ) : null}
      </div>
    </div>
  );
}
