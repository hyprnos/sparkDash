import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolEvalRun } from "../../../api/types";
import type { Translate } from "./format";
import { Tag } from "../../ui/Tag";
import { estimateRemaining, explainErrorCode, fmtDuration, toolNotes } from "./format";
import type { Followed } from "./hooks";
import { CopyButton, Notice, RunTerminal, linesText } from "./parts";
import { statusLabel, statusTone } from "./status";

interface LiveRunProps {
  followed: Followed;
  polling: boolean;
  pollError: string | null;
  actionError: string | null;
  /** Show per-scenario tracking (tool-call scenarios) rather than a phase view. */
  scenarioMode: boolean;
  onStop: () => void;
  onStopWatching: () => void;
  onAttach: (run: ToolEvalRun) => void;
  onRefresh: (run: ToolEvalRun) => void;
  onDismiss: () => void;
  onViewResult: (run: ToolEvalRun) => void;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/** Rows that fit in the collapsed scenario list; past this the list gets an expand toggle. */
const SCN_LIST_FOLD = 7;

const CHIP: Record<string, "good" | "warn" | "bad" | "neutral"> = { pass: "good", partial: "warn", fail: "bad", other: "neutral" };

/** Progress of the run being followed: counters, current scenario, per-scenario list, raw output, and the stop controls. */
export function LiveRun({ followed, polling, pollError, actionError, scenarioMode, onStop, onStopWatching, onAttach, onRefresh, onDismiss, onViewResult }: LiveRunProps) {
  const { t: translate } = useTranslation("bench");
  const t = translate as unknown as Translate;
  const { run, job, progress, lines, events, partial, noLive } = followed;
  const jobRunning = job?.status === "running";
  const running = run.status === "running" && (jobRunning || (polling && !job));
  const now = useNow(running);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [showTerm, setShowTerm] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const end = run.finishedAt ?? (running ? now : (job?.finishedAt ?? now));
  const elapsed = Math.max(0, (end - run.startedAt) / 1000);
  const p = progress;
  const total = p?.total ?? null;
  const done = p?.done ?? 0;
  const pct = total ? Math.min(100, (done / total) * 100) : null;
  const eta = running ? estimateRemaining(elapsed, done, total) : null;
  const finished = run.status !== "running";
  const lostWatch = !running && !finished; // run is still going on the Spark, but nobody is reading it
  const err = p?.error ?? null;
  const live = running && !stopping;
  const notes = useMemo(() => toolNotes(lines, t), [lines, t]);
  const errLines = lines.filter((l) => l.stream === "err" && !l.text.startsWith("{")).slice(-3);

  // Keep the newest scenario in view while the list grows, unless the reader scrolled up to look back.
  const listRef = useRef<HTMLUListElement | null>(null);
  const pinnedRef = useRef(true);
  const scenarioCount = p?.scenarios.length ?? 0;
  // A new run starts pinned to the newest scenario again, whatever the last one's scroll position was.
  useEffect(() => {
    pinnedRef.current = true;
  }, [run.id]);
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [scenarioCount]);

  useEffect(() => {
    if (!running) {
      setConfirmStop(false);
      setStopping(false);
    }
  }, [running]);

  const phaseText = (() => {
    if (!p) return t("te.live.starting");
    switch (p.phase) {
      case "starting":
        return t("te.live.startingTool");
      case "connecting":
        return t("te.live.connected", {
          target: p.server?.baseUrl ?? t("te.live.theServer"),
          backend: p.server?.backend ? ` (${p.server.backend})` : "",
        });
      case "running":
        return scenarioMode ? t("te.live.runningScenarios") : t("te.live.measuring");
      case "done":
        return t("te.live.finished");
      case "error":
        return t("te.live.error");
      default:
        return p.phase;
    }
  })();

  return (
    <section className="panel te-card te-live" aria-label={t("te.live.aria")}>
      <div className="te-card__head">
        <div>
          <div className="eyebrow">{finished ? t("te.live.lastRun") : t("te.live.runInProgress")}</div>
          <h2>
            {run.typeLabel}
            {run.label ? <span className="te-faint"> · {run.label}</span> : null}
          </h2>
        </div>
        <div className="te-live__tags">
          <Tag tone={statusTone(run.status)}>{statusLabel(run.status, jobRunning, t)}</Tag>
          {p?.model || run.model ? <Tag tone="neutral" title={t("te.live.model")}>{p?.model ?? run.model}</Tag> : null}
        </div>
      </div>

      <div className="te-progress" role="group" aria-label={t("te.live.progressAria")}>
        <div
          className={`te-bar ${pct == null && running ? "is-indeterminate" : ""}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total || undefined}
          aria-valuenow={pct == null ? undefined : done}
          aria-valuetext={total ? t("te.live.scenariosOf", { done, total }) : phaseText}
        >
          <i className={err || run.status === "failed" ? "is-bad" : undefined} style={pct != null ? { width: `${pct}%` } : finished ? { width: "100%" } : undefined} />
        </div>
        <div className="te-progress__meta" aria-live="polite">
          <span>
            {total ? (
              <>
                <b className="mono">{done}</b> / {total} {t("te.live.scenarios")}
              </>
            ) : (
              phaseText
            )}
          </span>
          <span className="te-faint">
            {t("te.live.elapsed", { duration: fmtDuration(elapsed, t) })}
            {eta != null ? t("te.live.left", { duration: fmtDuration(eta, t) }) : ""}
          </span>
        </div>
      </div>

      {scenarioMode && p ? (
        <div className="te-counters">
          <span className="te-counter-chip is-pass"><b>{p.counts.pass}</b> {t("te.live.pass")}</span>
          <span className="te-counter-chip is-partial"><b>{p.counts.partial}</b> {t("te.live.partial")}</span>
          <span className="te-counter-chip is-fail"><b>{p.counts.fail}</b> {t("te.live.fail")}</span>
          {p.counts.other ? <span className="te-counter-chip"><b>{p.counts.other}</b> {t("te.live.other")}</span> : null}
          <span className="te-faint te-counters__pts">{t("te.live.points", { count: p.points })}</span>
        </div>
      ) : null}

      {live ? (
        <p className="te-current" aria-live="polite">
          {scenarioMode && p?.current?.id ? (
            <>
              {t("te.live.now")} <b className="mono">{p.current.id}</b>
              {p.current.title ? ` ${p.current.title}` : ""}
              {p.current.category ? <Tag tone="neutral">{p.current.category}</Tag> : null}
            </>
          ) : (
            phaseText
          )}
        </p>
      ) : null}

      {notes.length ? (
        <Notice tone="info" title={t("te.live.goodToKnow")}>
          {notes.map((n) => (
            <p key={n.key}>{n.text}</p>
          ))}
        </Notice>
      ) : null}

      {err || run.status === "failed" ? (
        <Notice
          tone="bad"
          title={
            err
              ? t("te.live.toolError")
              : run.exitCode != null
                ? t("te.live.runFailedCode", { code: run.exitCode })
                : t("te.live.runFailed")
          }
        >
          {err
            ? explainErrorCode(err.code, err.message, t)
            : errLines.length
              ? errLines.map((l) => l.text).join(" / ")
              : t("te.live.openRawOutput")}
        </Notice>
      ) : null}
      {run.status === "stopped" ? <Notice tone="warn" title={t("te.live.stoppedTitle")}>{t("te.live.stoppedBody")}</Notice> : null}
      {job?.status === "detached" || (lostWatch && job) ? (
        <Notice
          tone="warn"
          title={t("te.live.lostViewTitle")}
          actions={
            <>
              <button type="button" className="btn btn--sm" onClick={() => onAttach(run)}>{t("te.live.reattach")}</button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => onRefresh(run)}>{t("te.live.checkStatus")}</button>
            </>
          }
        >
          {job?.error ?? t("te.live.mayStillRun")}
        </Notice>
      ) : null}
      {lostWatch && !job ? (
        <Notice
          tone="info"
          title={noLive ? t("te.live.notWatchingTitle") : t("te.live.detachedTitle")}
          actions={
            <>
              <button type="button" className="btn btn--sm" onClick={() => onAttach(run)}>{t("te.live.watchAgain")}</button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => onRefresh(run)}>{t("te.live.checkStatus")}</button>
            </>
          }
        >
          {t("te.live.notWatchingBody")}
        </Notice>
      ) : null}
      {pollError ? <Notice tone="warn" title={t("te.live.pollLost")}>{pollError}</Notice> : null}
      {actionError ? <Notice tone="bad">{actionError}</Notice> : null}

      {scenarioMode && p && p.scenarios.length > SCN_LIST_FOLD ? (
        <div className="te-scn-toggle">
          <button type="button" className="btn btn--sm btn--ghost" aria-expanded={listOpen} onClick={() => setListOpen((o) => !o)}>
            {listOpen ? t("te.live.collapseList") : t("te.live.expandList")}
          </button>
        </div>
      ) : null}
      {scenarioMode && p && p.scenarios.length ? (
        <ul
          ref={(el) => {
            if (el && listRef.current !== el) pinnedRef.current = true; // a freshly mounted list starts pinned
            listRef.current = el;
          }}
          className={`te-scn-list${running ? " is-live" : ""}${listOpen ? " is-open" : ""}`}
          aria-label={t("te.live.scenariosSoFar")}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {p.scenarios.map((s, i) => (
            <li key={`${s.id}-${i}`} className={`is-${CHIP[s.status] ?? "neutral"}`} title={`${s.title ?? ""} ${s.points != null ? `· ${s.points} pts` : ""}`}>
              <Tag tone={CHIP[s.status] ?? "neutral"}>{s.status}</Tag>
              <span className="mono">{s.id}</span>
              <span className="te-scn-list__title">{s.title ?? ""}</span>
              {s.durationSeconds != null ? <span className="te-faint">{s.durationSeconds.toFixed(1)}s</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!scenarioMode && events.length ? (
        <ul className="te-events" aria-label={t("te.live.recentActivity")}>
          {events.slice(-6).map((e) => (
            <li key={e.seq}>
              <span className="mono">{e.event}</span>
              <span className="te-faint">{eventBrief(e)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="te-actions">
        {running ? (
          confirmStop ? (
            <>
              <span className="te-confirm-text">{t("te.live.stopConfirm")}</span>
              <button
                type="button"
                className="btn btn--danger"
                disabled={stopping}
                onClick={() => {
                  setStopping(true);
                  onStop();
                }}
              >
                {stopping ? t("te.live.stopping") : t("te.live.yesStop")}
              </button>
              <button type="button" className="btn" onClick={() => setConfirmStop(false)}>{t("te.live.keepRunning")}</button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn--danger" onClick={() => setConfirmStop(true)}>{t("te.live.stopRun")}</button>
              <button type="button" className="btn btn--ghost" onClick={onStopWatching} title={t("te.live.stopWatchingTitle")}>
                {t("te.live.stopWatching")}
              </button>
            </>
          )
        ) : null}
        {finished && run.status === "completed" ? (
          <button type="button" className="btn btn--primary" onClick={() => onViewResult(run)}>{t("te.live.viewResult")}</button>
        ) : null}
        {finished ? <button type="button" className="btn btn--ghost" onClick={onDismiss}>{t("te.live.dismiss")}</button> : null}
        <button type="button" className="btn btn--ghost te-actions__end" aria-expanded={showTerm} onClick={() => setShowTerm((s) => !s)}>
          {showTerm ? t("te.live.hideRaw") : t("te.live.rawOutput", { count: lines.length })}
        </button>
      </div>
      {running ? <p className="te-faint">{t("te.live.stopWatchingHint")}</p> : null}
      {showTerm ? (
        <div className="te-live__term">
          <div className="te-json__bar">
            <span className="te-faint">{t("te.live.termNote")}</span>
            <CopyButton text={() => linesText(lines, partial)} label={t("te.live.copyOutput")} />
          </div>
          <RunTerminal lines={lines} partial={partial} running={running} />
        </div>
      ) : null}
    </section>
  );
}

function eventBrief(e: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (k === "seq" || k === "event") continue;
    if (typeof v === "string" || typeof v === "number") parts.push(`${k}=${String(v).slice(0, 60)}`);
    if (parts.length >= 3) break;
  }
  return parts.join(" ");
}
