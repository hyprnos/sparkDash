import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolEvalRun } from "../../../api/types";
import type { Translate } from "./format";
import { Tag } from "../../ui/Tag";
import { buildToolEvalCompareShareCard } from "../../SparkPage/benchShareCard";
import { ShowCardButton } from "./ShowCardButton";
import { OtherSparkRuns } from "./OtherSparkRuns";
import { useBenchSparks } from "../SparkChips";
import { compareGeneric, configCaveats, normalizeForCompare } from "./compare";
import { SideBySide } from "./SideBySide";
import { fmtDate, fmtDuration, fmtNum } from "./format";
import { useToolEvalResult } from "./hooks";
import { Notice, Skeleton } from "./parts";
import { CATEGORY_NAMES } from "./normalize";
import { statusLabel, statusTone } from "./status";

interface HistoryProps {
  sparkId: string;
  sparkName: string;
  type: string;
  runs: ToolEvalRun[] | null;
  error: string | null;
  followedId: string | null;
  viewedId: string | null;
  onReload: () => void;
  onOpen: (run: ToolEvalRun) => void;
  onRerun: (run: ToolEvalRun) => void;
  onDelete: (run: ToolEvalRun) => Promise<boolean>;
  onRefresh: (run: ToolEvalRun) => Promise<boolean>;
  onAttach: (run: ToolEvalRun) => void;
}

function headline(run: ToolEvalRun): string {
  const s = run.summary;
  if (s?.finalScore != null) return fmtNum(s.finalScore, 1);
  return "–";
}

/** Runs of this page type on this Spark, with open / re-run / delete and a two-run compare. */
export function History({ sparkId, sparkName, type, runs, error, followedId, viewedId, onReload, onOpen, onRerun, onDelete, onRefresh, onAttach }: HistoryProps) {
  const { t: translate } = useTranslation("bench");
  const t = translate as unknown as Translate;
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // A finished run from another Spark: compared against the one ticked run here (A = this Spark, B = the other).
  const [other, setOther] = useState<ToolEvalRun | null>(null);
  const [crossOpen, setCrossOpen] = useState(false);
  const { sparks } = useBenchSparks();
  const otherSparks = useMemo(() => sparks.filter((s) => s.id !== sparkId), [sparks, sparkId]);
  const sparkNames = useMemo(() => new Map(sparks.map((s) => [s.id, s.name])), [sparks]);
  const nameOf = (r: ToolEvalRun) => (r.sparkId === sparkId ? sparkName : sparkNames.get(r.sparkId) ?? r.sparkId);
  // With an other-Spark run chosen, one tick is enough; otherwise two runs of this Spark.
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(other ? 0 : -1), id]));
  const pair = useMemo(() => {
    if (!runs) return null;
    if (other) {
      const mine = picked.length === 1 ? runs.find((r) => r.id === picked[0]) : undefined;
      return mine ? ([mine, other] as [ToolEvalRun, ToolEvalRun]) : null;
    }
    if (picked.length !== 2) return null;
    const found = picked.map((id) => runs.find((r) => r.id === id)).filter((r): r is ToolEvalRun => Boolean(r));
    return found.length === 2 ? ([...found].sort((a, b) => a.startedAt - b.startedAt) as [ToolEvalRun, ToolEvalRun]) : null;
  }, [picked, runs, other]);

  if (error && !runs) {
    return <Notice tone="bad" title={t("te.history.loadFailed")} actions={<button type="button" className="btn btn--sm" onClick={onReload}>{t("te.history.retry")}</button>}>{error}</Notice>;
  }
  if (!runs) return <Skeleton lines={4} className="te-card te-card--pad" />;
  if (!runs.length) {
    return (
      <div className="te-empty te-empty--big">
        <b>{t("te.history.emptyTitle")}</b>
        <p>{t("te.history.emptyBody", { name: sparkName })}</p>
      </div>
    );
  }

  return (
    <div className="te-history">
      <p className="te-note">{t("te.history.note")}</p>
      {otherSparks.length ? (
        <div className="te-xspark__toggle">
          <button
            type="button"
            className="btn btn--sm"
            aria-expanded={crossOpen}
            onClick={() => {
              if (crossOpen) {
                setOther(null);
                setPicked((p) => p.slice(-1));
              }
              setCrossOpen(!crossOpen);
            }}
          >
            {crossOpen ? t("te.history.compareOwn") : t("te.history.compareOther")}
          </button>
        </div>
      ) : null}
      {crossOpen ? (
        <OtherSparkRuns
          sparks={otherSparks}
          type={type}
          selected={other}
          onSelect={(r) => {
            setOther(r);
            // Two ticks were for a same-Spark comparison; keep the newest one.
            if (r) setPicked((p) => p.slice(-1));
          }}
        />
      ) : null}
      <ul className="te-runs">
        {runs.map((r) => {
          const stuck = r.status === "running" && r.id !== followedId;
          const dur = r.finishedAt ? (r.finishedAt - r.startedAt) / 1000 : null;
          return (
            <li key={r.id} className={`te-run ${viewedId === r.id ? "is-viewed" : ""}`}>
              <label className="te-run__pick" title={t("te.history.pickTitle")}>
                <input
                  type="checkbox"
                  checked={picked.includes(r.id)}
                  onChange={() => toggle(r.id)}
                  aria-label={t("te.history.pickAria", { date: fmtDate(r.startedAt) })}
                />
              </label>
              <div className="te-run__main">
                <div className="te-run__title">
                  <b>{r.label || fmtDate(r.startedAt)}</b>
                  <Tag tone={statusTone(r.status)}>{statusLabel(r.status, !stuck, t)}</Tag>
                  {r.summary?.rating ? <span className="te-faint">{r.summary.rating}</span> : null}
                </div>
                <div className="te-faint te-run__sub">
                  {r.label ? `${fmtDate(r.startedAt)} · ` : ""}
                  {r.model ?? t("te.history.autoModel")} · {dur != null ? fmtDuration(dur, t) : t("te.history.inProgress")}
                  {r.summary?.counts
                    ? ` · ${t("te.history.counts", {
                        pass: r.summary.counts.pass,
                        partial: r.summary.counts.partial,
                        fail: r.summary.counts.fail,
                      })}`
                    : ""}
                  {r.summary?.safetyWarnings ? ` · ${t("te.history.safetyWarnings", { count: r.summary.safetyWarnings })}` : ""}
                </div>
              </div>
              <div className="te-run__score" title={r.summary ? t("te.history.finalScore") : t("te.history.noHeadline")}>
                <b className="big-num">{headline(r)}</b>
              </div>
              <div className="te-run__actions">
                {confirmDel === r.id ? (
                  <>
                    <span className="te-confirm-text">{t("te.history.deleteConfirm")}</span>
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      disabled={busyId === r.id}
                      onClick={async () => {
                        setBusyId(r.id);
                        await onDelete(r);
                        setBusyId(null);
                        setConfirmDel(null);
                        setPicked((p) => p.filter((x) => x !== r.id));
                      }}
                    >
                      {t("te.history.delete")}
                    </button>
                    <button type="button" className="btn btn--sm" onClick={() => setConfirmDel(null)}>{t("te.history.cancel")}</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn--sm" onClick={() => onOpen(r)}>{t("te.history.open")}</button>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => onRerun(r)} title={t("te.history.rerunTitle")}>{t("te.history.rerun")}</button>
                    {stuck ? (
                      <>
                        <button type="button" className="btn btn--sm btn--ghost" onClick={() => onAttach(r)}>{t("te.history.watch")}</button>
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          disabled={busyId === r.id}
                          onClick={async () => {
                            setBusyId(r.id);
                            await onRefresh(r);
                            setBusyId(null);
                          }}
                          title={t("te.history.refreshTitle")}
                        >
                          {busyId === r.id ? t("te.history.checking") : t("te.history.refreshStatus")}
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      disabled={r.status === "running"}
                      onClick={() => setConfirmDel(r.id)}
                      title={r.status === "running" ? t("te.history.stopFirst") : t("te.history.delete")}
                    >
                      {t("te.history.delete")}
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {crossOpen && !other ? <p className="te-faint">{t("te.history.chooseOther")}</p> : null}
      {crossOpen && other && !picked.length ? <p className="te-faint">{t("te.history.tickOwn", { name: sparkName })}</p> : null}
      {!crossOpen && picked.length === 1 ? <p className="te-faint">{t("te.history.selectMore")}</p> : null}
      {pair ? <ComparePanel key={`${pair[0].id}:${pair[1].id}`} sparkName={sparkName} nameOf={nameOf} a={pair[0]} b={pair[1]} /> : null}
    </div>
  );
}

/** Two runs side by side: deltas, categories and changed scenarios (or changed metrics for other result types). */
function ComparePanel({ sparkName, nameOf, a, b }: { sparkName: string; nameOf: (r: ToolEvalRun) => string; a: ToolEvalRun; b: ToolEvalRun }) {
  const { t: translate } = useTranslation("bench");
  const t = translate as unknown as Translate;
  const [swapped, setSwapped] = useState(false);
  const ref = useRef<HTMLElement>(null);
  // Picking the second run opens the comparison: bring it into view.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, []);
  // Each result is read from the Spark its run belongs to: the two sides may be different Sparks.
  const ra = useToolEvalResult(a.sparkId, a.id);
  const rb = useToolEvalResult(b.sparkId, b.id);
  const cross = a.sparkId !== b.sparkId;
  const first = swapped ? b : a;
  const second = swapped ? a : b;
  const caveats = configCaveats(a, b, t);
  const loading = ra.loading || rb.loading;
  const error = ra.error || rb.error;
  const na = ra.result ? normalizeForCompare(ra.result) : null;
  const nb = rb.result ? normalizeForCompare(rb.result) : null;
  const tool = na && nb ? { a: swapped ? nb : na, b: swapped ? na : nb } : null;
  const generic = !tool && ra.result && rb.result ? compareGeneric(ra.result, rb.result) : null;

  return (
    <section ref={ref} className="panel te-card te-compare" aria-label={t("te.compare.aria")}>
      <div className="te-card__head">
        <h2>{t("te.compare.title")}</h2>
        {tool ? (
          <ShowCardButton
            kind="tool-eval-compare"
            label={t("te.compare.showCard")}
            build={() => buildToolEvalCompareShareCard(tool.a, tool.b, first, second, { sparkName, sparkNameA: cross ? nameOf(first) : null, sparkNameB: cross ? nameOf(second) : null })}
            dialogLabel={t("te.compare.cardDialog")}
            imgAlt={t("te.compare.cardAlt")}
            title={t("te.compare.cardTitle")}
          />
        ) : null}
      </div>
      {caveats.length ? (
        <Notice tone="warn" title={t("te.compare.notComparable")}>
          <ul className="te-list">
            {caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          {t("te.compare.caveatNote")}
        </Notice>
      ) : (
        <p className="te-ok">
          {cross ? t("te.compare.fairAmong", { a: nameOf(a), b: nameOf(b) }) : t("te.compare.fair")}
        </p>
      )}
      {loading ? <Skeleton lines={4} /> : null}
      {error ? <Notice tone="bad" title={t("te.compare.loadFailed")}>{error}</Notice> : null}
      {tool ? <SideBySide a={tool.a} b={tool.b} runA={first} runB={second} sparkNameA={cross ? nameOf(first) : null} sparkNameB={cross ? nameOf(second) : null} onSwap={() => setSwapped((v) => !v)} /> : null}
      {generic ? (
        generic.changed.length ? (
          <div className="te-tablewrap">
            <table className="te-table">
              <thead>
                <tr>
                  <th scope="col">{t("te.compare.metric")}</th>
                  <th scope="col" className="is-num">A</th>
                  <th scope="col" className="is-num">B</th>
                  <th scope="col" className="is-num">{t("te.compare.change")}</th>
                </tr>
              </thead>
              <tbody>
                {generic.changed.map((m) => (
                  <tr key={m.path}>
                    <th scope="row" className="mono">{m.path}</th>
                    <td className="is-num">{m.a != null ? fmtNum(m.a, 3) : "–"}</td>
                    <td className="is-num">{m.b != null ? fmtNum(m.b, 3) : "–"}</td>
                    <td className="is-num">{m.pct != null ? `${m.pct > 0 ? "+" : ""}${m.pct.toFixed(1)}%` : m.delta != null ? fmtNum(m.delta, 3) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="te-faint">{t("te.compare.identical", { count: generic.same })}</p>
          </div>
        ) : (
          <p className="te-empty">{t("te.compare.noDiff")}</p>
        )
      ) : null}
      {!loading && !error && !tool && !generic ? <p className="te-empty">{t("te.compare.nothing")}</p> : null}
    </section>
  );
}

