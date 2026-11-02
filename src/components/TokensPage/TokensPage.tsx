import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { fetchTokenHistory, resetTokenTotals } from "../../api/client";
import { ClearMenu, type ClearChoice } from "../ui/ClearMenu";
import { fetchLlmTokenCost, fetchLlmTokenTotals, type LlmTokenCost } from "../../api/llmTokenClient";
import { CloudPriceSetting } from "../CloudPriceSetting";
import type { LlmTokenSeriesTotals } from "../../api/llmTokenTypes";
import type { SparkSnapshot, TokenHistory } from "../../api/types";
import { formatTokensCompact } from "../../shared/tokenFormat";
import { StackedBarChart, type BarBucket, type BarSeries } from "../ui/StackedBarChart";
import { EndpointTable, ModelTable } from "./TokenTables";
import {
  OTHER_ID,
  RANGES,
  bucketLabel,
  bucketTitle,
  bucketTotals,
  buildCsv,
  buildInsights,
  calendarDayRows,
  compare,
  endpointRows,
  entriesFromTotals,
  fmtPct,
  groupBuckets,
  lastSeenByModel,
  modelRows,
  rowsIn,
  summarize,
  tallyOf,
  trackedBuckets,
  windowFor,
  type Comparison,
  type GroupBy,
  type RangeKey,
  type Summary,
  type Translate,
} from "./tokenStats";
import "../../styles/tokens.css";

const POLL_MS = 30_000;
const fmt = formatTokensCompact;

const GROUPS: GroupBy[] = ["type", "model", "spark"];
const TYPE_COLORS: Record<string, string> = {
  generated: "var(--color-accent)",
  cached: "var(--color-info)",
  computed: "var(--color-violet)",
  unknown: "var(--color-muted)",
};
const GROUP_COLORS = ["var(--color-accent)", "var(--color-info)", "var(--color-violet)", "var(--color-success)", "var(--color-warning)"];

/** Range tab, sentence and comparison wording, one static catalog key per string. */
interface RangeCopy {
  label: string;
  phrase: string;
  prev: string;
}

function rangeCopies(t: Translate): Record<RangeKey, RangeCopy> {
  return {
    today: { label: t("range.today.label"), phrase: t("range.today.phrase"), prev: t("range.today.prev") },
    week: { label: t("range.week.label"), phrase: t("range.week.phrase"), prev: t("range.week.prev") },
    month: { label: t("range.month.label"), phrase: t("range.month.phrase"), prev: t("range.month.prev") },
    "24h": { label: t("range.24h.label"), phrase: t("range.24h.phrase"), prev: t("range.24h.prev") },
    "7d": { label: t("range.7d.label"), phrase: t("range.7d.phrase"), prev: t("range.7d.prev") },
    "14d": { label: t("range.14d.label"), phrase: t("range.14d.phrase"), prev: t("range.14d.prev") },
    "30d": { label: t("range.30d.label"), phrase: t("range.30d.phrase"), prev: t("range.30d.prev") },
    all: { label: t("range.all.label"), phrase: t("range.all.phrase"), prev: t("range.all.prev") },
  };
}

function groupLabel(t: Translate, key: GroupBy): string {
  switch (key) {
    case "type":
      return t("chart.groupType");
    case "model":
      return t("chart.groupModel");
    default:
      return t("chart.groupSpark");
  }
}

/** Chart series names; model and Spark series keep their own (data) names. */
function seriesLabel(t: Translate, id: string): string | null {
  switch (id) {
    case "generated":
      return t("chart.seriesGenerated");
    case "cached":
      return t("chart.seriesCached");
    case "computed":
      return t("chart.seriesComputed");
    case "unknown":
      return t("chart.seriesUnknown");
    case OTHER_ID:
      return t("chart.seriesOther");
    default:
      return null;
  }
}

interface Loaded {
  history: TokenHistory;
  /** Lifetime totals; null when that endpoint failed (All time then falls back to retained days). */
  lifetime: LlmTokenSeriesTotals[] | null;
  at: number;
}

export function TokensPage({ sparks, onSelectSpark }: { sparks: SparkSnapshot[]; onSelectSpark?: (id: string) => void }) {
  const { t: translate } = useTranslation("tokens");
  const t = translate as unknown as Translate;
  const [range, setRange] = useState<RangeKey>("today");
  const [groupBy, setGroupBy] = useState<GroupBy>("type");
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [copyMsg, setCopyMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      Promise.all([fetchTokenHistory(), fetchLlmTokenTotals("all").then((r) => r.series || []).catch(() => null)])
        .then(([history, lifetime]) => {
          if (cancelled) return;
          setData({ history, lifetime, at: Date.now() });
          setError(null);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : t("loadFailedShort"));
        });
    };
    run();
    const id = setInterval(() => {
      if (!document.hidden) run();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tick, t]);

  useEffect(() => {
    if (!copyMsg) return;
    const timer = setTimeout(() => setCopyMsg(null), 4000);
    return () => clearTimeout(timer);
  }, [copyMsg]);

  const sparkNames = useMemo(() => new Map(sparks.map((s) => [s.id, s.name])), [sparks]);
  const tokenResetChoices = useMemo<ClearChoice<string | undefined>[]>(
    () => [
      { id: "all", label: t("resetAll"), ask: t("resetAskAll"), arg: undefined },
      ...sparks.map((s) => ({ id: s.id, label: s.name, ask: t("resetAskSpark", { name: s.name }), arg: s.id })),
    ],
    [sparks, t]
  );
  const sparkName = useCallback((id: string) => sparkNames.get(id) || id, [sparkNames]);
  const knownSpark = useCallback((id: string) => sparkNames.has(id), [sparkNames]);

  const view = useMemo(() => {
    if (!data) return null;
    const { history, lifetime, at } = data;
    const w = windowFor(range, history, at);
    const unit = w.spec.unit;
    // Calendar weeks/months are local days, folded from the hourly rows; UTC days
    // cannot be split at a local midnight.
    const source = w.spec.calendar && unit === "day"
      ? calendarDayRows(history.hour, history.day, undefined, history.firstDay)
      : unit === "hour" ? history.hour : history.day;
    const inRange = rowsIn(source, w.keys);
    const useLifetime = range === "all" && lifetime != null;
    const entries = useLifetime ? entriesFromTotals(lifetime) : inRange;
    const tally = tallyOf(entries);
    const totals = bucketTotals(inRange, w.keys);
    const elapsed = range === "all" ? trackedBuckets(w.firstKey, "day", at) ?? undefined : undefined;
    const summary = summarize(tally, totals, w.firstKey, elapsed);
    const comparison = w.prevKeys.length ? compare(tally, tallyOf(rowsIn(source, w.prevKeys))) : null;
    const models = modelRows(entries, lifetime ? lastSeenByModel(lifetime) : undefined);
    const endpoints = endpointRows(entries);
    const hasRetainedHistory = history.day.length > 0 || history.hour.length > 0;
    return { w, unit, inRange, tally, totals, summary, comparison, models, endpoints, at, hasRetainedHistory, useLifetime };
  }, [data, range]);

  const grouped = useMemo(
    () => (view ? groupBuckets(view.inRange, view.w.keys, groupBy, { sparkName }) : null),
    [view, groupBy, sparkName]
  );

  const insights = useMemo(() => {
    if (!view) return [];
    const copy = rangeCopies(t)[view.w.spec.key];
    return buildInsights(
      {
        spec: view.w.spec,
        summary: view.summary,
        comparison: view.comparison,
        models: view.models,
        endpoints: view.endpoints,
        totals: view.totals,
        firstKey: view.w.firstKey,
        sparkName,
        localDays: view.w.localDays,
        unit: view.unit === "hour" ? t("units.hour") : t("units.day"),
        unitPlural: view.unit === "hour" ? t("units.hours") : t("units.days"),
        period: copy.phrase,
        prevPeriod: copy.prev,
        locale: document.documentElement.lang || undefined,
      },
      t
    );
  }, [view, sparkName, t]);

  const copyCsv = async () => {
    if (!view) return;
    const text = buildCsv(view.inRange, sparkName, view.w.localDays);
    const n = view.inRange.length;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error("no clipboard");
      setCopyMsg({ ok: true, text: t("copied", { rows: n }) });
    } catch {
      // Insecure origins block the async clipboard API; fall back to a hidden textarea.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.className = "tk-sr";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        setCopyMsg(ok ? { ok: true, text: t("copied", { rows: n }) } : { ok: false, text: t("copyFailed") });
      } catch {
        setCopyMsg({ ok: false, text: t("copyFailed") });
      }
    }
  };

  const spec = RANGES.find((r) => r.key === range) ?? RANGES.find((r) => r.key === "7d")!;
  const copy = rangeCopies(t)[spec.key];
  const unit = spec.unit === "hour" ? { one: t("units.hour"), per: t("units.perHour") } : { one: t("units.day"), per: t("units.perDay") };
  const rangeOpts = { locale: document.documentElement.lang || undefined, utc: t("chart.utc"), local: t("chart.local") };

  const series: BarSeries[] = (grouped?.series ?? []).map((s, i) => ({
    id: s.id,
    label: seriesLabel(t, s.id) ?? s.label,
    color: groupBy === "type" ? TYPE_COLORS[s.id] : s.id === OTHER_ID ? "var(--color-faint)" : GROUP_COLORS[i % GROUP_COLORS.length],
  }));
  const buckets: BarBucket[] = (grouped?.buckets ?? []).map((b) => ({
    key: b.key,
    label: bucketLabel(b.key, spec.unit, undefined, rangeOpts),
    title: bucketTitle(b.key, spec.unit, undefined, spec.localDays, rangeOpts),
    values: b.values,
  }));
  const chartEmpty = range === "24h" ? t("chart.empty24h") : t("chart.emptyRange");

  return (
    <div className="tk">
      <header className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <p className="page-head__sub">{t("subtitle")}</p>
        </div>
        <div className="page-head__tools">
          <div className="seg" role="group" aria-label={t("rangeGroup")}>
            {RANGES.map((r) => (
              <button key={r.key} type="button" className={r.key === range ? "is-on" : undefined} aria-pressed={r.key === range} onClick={() => setRange(r.key)}>
                {rangeCopies(t)[r.key].label}
              </button>
            ))}
          </div>
          <ClearMenu
            label={t("reset")}
            choices={tokenResetChoices}
            note={t("resetNote")}
            onRun={async (id) => {
              const { removed } = await resetTokenTotals(id);
              setTick((value) => value + 1);
              return removed;
            }}
          />
          <button type="button" className="btn btn--sm" onClick={copyCsv} disabled={!view || view.inRange.length === 0}>
            {t("copyCsv")}
          </button>
          <span className={`tk-copymsg${copyMsg && !copyMsg.ok ? " is-err" : ""}`} role="status" aria-live="polite">
            {copyMsg?.text}
          </span>
        </div>
      </header>

      {!data && !error ? (
        <div className="panel tk-note" role="status">
          {t("loading")}
        </div>
      ) : null}

      {error ? (
        <div className="panel tk-note tk-note--err" role="alert">
          <span>{data ? t("refreshFailed", { message: error }) : t("loadFailed", { message: error })}</span>
          <button type="button" className="btn btn--sm" onClick={() => setTick((value) => value + 1)}>
            {t("retry")}
          </button>
        </div>
      ) : null}

      {view ? (
        <>
          {view.summary.total > 0 ? <Tiles s={view.summary} cmp={view.comparison} spec={spec} t={t} /> : null}
          <CostCard range={range} />

          <div className="tk-grid">
            <section className="panel tk-card" aria-labelledby="tk-chart-title">
              <div className="tk-card__head">
                <div>
                  <h2 id="tk-chart-title" className="tk-card__title">
                    {t("chart.title", { unit: unit.one })}
                  </h2>
                  <p className="tk-card__sub">
                    {spec.unit === "hour" ? t("chart.subHourly") : range === "all" ? t("chart.subAllTime") : spec.localDays ? t("chart.subLocalDays") : t("chart.subUtcDays")}
                  </p>
                </div>
                <div className="tk-card__tools">
                  <span className="eyebrow">{t("chart.groupBy")}</span>
                  <div className="seg" role="group" aria-label={t("chart.groupAria")}>
                    {GROUPS.map((g) => (
                      <button key={g} type="button" className={g === groupBy ? "is-on" : undefined} aria-pressed={g === groupBy} onClick={() => setGroupBy(g)}>
                        {groupLabel(t, g)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <StackedBarChart
                buckets={buckets}
                series={series}
                height={260}
                format={fmt}
                unit="tokens"
                empty={chartEmpty}
                ariaLabel={t("chart.ariaLabel", { unit: unit.one, period: copy.phrase, group: groupLabel(t, groupBy) })}
              />
              <ul className="legend tk-legend">
                {series.map((s, i) => (
                  <li key={s.id} style={{ "--c": s.color } as CSSProperties}>
                    <span>{s.label}</span>
                    <em className="mono">{fmt(grouped?.series[i].total ?? 0)}</em>
                  </li>
                ))}
              </ul>
            </section>

            <section className="panel tk-card" aria-labelledby="tk-insights-title">
              <h2 id="tk-insights-title" className="tk-card__title">
                {t("insights.title")}
              </h2>
              {insights.length > 0 ? (
                <ul className="tk-insights">
                  {insights.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="tk-card__sub">{t("insights.empty", { period: copy.phrase })}</p>
              )}
            </section>
          </div>

          {view.summary.total > 0 ? (
            <>
              <section className="panel tk-card" aria-labelledby="tk-models-title">
                <div className="tk-card__head">
                  <div>
                    <h2 id="tk-models-title" className="tk-card__title">
                      {t("insights.byModel")}
                    </h2>
                    <p className="tk-card__sub">{t("insights.byModelSub", { count: view.models.length, period: copy.phrase })}</p>
                  </div>
                </div>
                <ModelTable rows={view.models} sparkName={sparkName} nowMs={view.at} />
              </section>

              <section className="panel tk-card" aria-labelledby="tk-eps-title">
                <div className="tk-card__head">
                  <div>
                    <h2 id="tk-eps-title" className="tk-card__title">
                      {t("insights.byEndpoint")}
                    </h2>
                    <p className="tk-card__sub">{t("insights.byEndpointSub")}</p>
                  </div>
                </div>
                <EndpointTable rows={view.endpoints} sparkName={sparkName} knownSpark={knownSpark} onSelectSpark={onSelectSpark} />
              </section>
            </>
          ) : (
            <section className="panel tk-note" role="status">
              <b>{t("insights.noTrafficTitle", { period: copy.phrase })}</b>
              <span>
                {" "}
                {view.hasRetainedHistory ? t("insights.tryLonger") : t("insights.historyHint")}
              </span>
            </section>
          )}

          <section className="panel tk-card tk-about" aria-labelledby="tk-about-title">
            <h2 id="tk-about-title" className="tk-card__title">
              {t("about.title")}
            </h2>
            <ul>
              <li>
                {t("about.zones")}
                {data?.history.firstDay ? <>{" "}{t("about.trackingBegan", { date: data.history.firstDay })}</> : null}
              </li>
              <li>{t("about.restarts")}</li>
              <li>{t("about.retention", { hours: data?.history.retention.hours ?? 840, days: data?.history.retention.days ?? 35 })}</li>
              <li>{data?.lifetime ? t("about.allTime") : t("about.allTimeUnavailable")}</li>
              <li>{t("about.vocabulary")}</li>
              {view.w.prevKeys.length === 0 && spec.key !== "all" ? <li>{t("about.noComparison")}</li> : null}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Delta({ value, suffix }: { value: number | null | undefined; suffix: string }) {
  const { t } = useTranslation("tokens");
  if (value == null || !Number.isFinite(value)) return null;
  const flat = Math.abs(value) < 0.005;
  return (
    <span className={`tk-delta ${flat ? "" : value > 0 ? "is-up" : "is-down"}`}>
      <span aria-hidden="true">{flat ? "→" : value > 0 ? "▲" : "▼"}</span> {flat ? t("tiles.flat") : fmtPct(Math.abs(value))} {suffix}
    </span>
  );
}

function Tile({ label, value, unit, sub, delta, title }: { label: string; value: string; unit?: string; sub?: string; delta?: React.ReactNode; title?: string }) {
  return (
    <div className="tk-tile" title={title}>
      <span className="eyebrow">{label}</span>
      <div className="big-num">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {sub ? <p className="tk-tile__sub">{sub}</p> : null}
      {delta}
    </div>
  );
}

function Tiles({ s, cmp, spec, t }: { s: Summary; cmp: Comparison | null; spec: (typeof RANGES)[number]; t: Translate }) {
  const copy = rangeCopies(t)[spec.key];
  const unit = spec.unit === "hour" ? { one: t("units.hour"), many: t("units.hours"), per: t("units.perHour") } : { one: t("units.day"), many: t("units.days"), per: t("units.perDay") };
  const prevWord = copy.prev;
  const ratio = s.genPerPrompt != null && s.generated > 0 ? s.prompt / s.generated : null;
  return (
    <section className="tk-tiles" aria-label={t("tiles.summaryAria", { period: copy.phrase })}>
      <Tile label={t("tiles.total")} value={fmt(s.total)} sub={t("tiles.totalSub")} title={s.total.toLocaleString()} delta={<Delta value={cmp?.total} suffix={t("tiles.vsPeriod", { period: prevWord })} />} />
      <Tile
        label={t("tiles.generated")}
        value={fmt(s.generated)}
        sub={s.total > 0 ? t("tiles.shareOfAll", { percent: fmtPct(s.generated / s.total) }) : undefined}
        title={s.generated.toLocaleString()}
        delta={<Delta value={cmp?.generated} suffix={t("tiles.vsPeriod", { period: prevWord })} />}
      />
      <Tile
        label={t("tiles.prompt")}
        value={fmt(s.prompt)}
        sub={
          s.prompt > 0
            ? t("tiles.promptSub", {
                cached: fmt(s.cached),
                uncached: fmt(Math.max(0, s.prompt - (s.cacheObservedPrompt ?? s.prompt))),
              })
            : t("tiles.promptNone")
        }
        title={s.prompt.toLocaleString()}
        delta={<Delta value={cmp?.prompt} suffix={t("tiles.vsPeriod", { period: prevWord })} />}
      />
      <Tile
        label={t("tiles.cacheRate")}
        value={s.cacheRate == null ? "—" : fmtPct(s.cacheRate, 1)}
        sub={
          s.prompt <= 0
            ? t("tiles.cacheNeedsPrompt")
            : s.cacheReported === false
              ? t("tiles.cacheNoCounter")
              : s.cached > 0
                ? `${t("tiles.cacheServed", { cached: fmt(s.cached), observed: fmt(s.cacheObservedPrompt ?? s.prompt) })}${
                    (s.cacheObservedPrompt ?? s.prompt) < s.prompt ? ` · ${t("tiles.cachePartial")}` : ""
                  }`
                : t("tiles.cacheNone")
        }
        delta={
          cmp?.cachePoints != null ? (
            <span className={`tk-delta ${Math.abs(cmp.cachePoints) < 0.5 ? "" : cmp.cachePoints > 0 ? "is-up" : "is-down"}`}>
              {t("tiles.cachePoints", {
                points: `${cmp.cachePoints >= 0 ? "+" : "−"}${Math.abs(cmp.cachePoints).toFixed(1)}`,
                period: prevWord,
              })}
            </span>
          ) : null
        }
      />
      <Tile
        label={t("tiles.ratio")}
        value={ratio == null ? "—" : `1 : ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}`}
        sub={ratio == null ? t("tiles.ratioNeeds") : t("tiles.ratioSub", { perPrompts: ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1) })}
      />
      <Tile
        label={t("tiles.average", { unit: unit.one })}
        value={fmt(Math.round(s.avgPerBucket))}
        unit={unit.per}
        sub={t("tiles.averageSub", { count: s.elapsed, unit: s.elapsed === 1 ? unit.one : unit.many })}
      />
      <Tile
        label={t("tiles.busiest", { unit: unit.one })}
        value={s.busiest ? fmt(s.busiest.total) : "—"}
        sub={
          s.busiest
            ? bucketTitle(s.busiest.key, spec.unit, undefined, spec.localDays, {
                locale: document.documentElement.lang || undefined,
                utc: t("chart.utc"),
                local: t("chart.local"),
              }).replace(/ \((?:[^()]*)\)$/, "")
            : t("tiles.busiestNone")
        }
        title={s.busiest ? s.busiest.total.toLocaleString() : undefined}
      />
    </section>
  );
}

/** Cloud-price estimate for the selected range, using the e-paper pricing settings. */
function CostCard({ range }: { range: RangeKey }) {
  const { t: translate } = useTranslation("tokens");
  const t = translate as unknown as Translate;
  const [cost, setCost] = useState<LlmTokenCost | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchLlmTokenCost(range)
      .then((next) => {
        if (!cancelled) {
          setCost(next);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  if (error) {
    return (
      <section className="panel tk-card tk-cost">
        <h2>{t("cost.title")}</h2>
        <p className="tk-cost__note">{error}</p>
      </section>
    );
  }
  if (!cost) return null;

  return (
    <section className="panel tk-card tk-cost">
      <h2>{t("cost.title")}</h2>
      <p className="tk-cost__value">
        {cost.formatted}
        <span className="tk-cost__range"> · {cost.label}</span>
      </p>
      <p className="tk-cost__note">
        {cost.tariff === "peak" ? t("cost.peak") : t("cost.offPeak")} ·{" "}
        {t("cost.rates", { hit: cost.rates.cacheHit, miss: cost.rates.cacheMiss, output: cost.rates.output })} ·{" "}
        {t("cost.einkNote")}
      </p>
      <details className="tk-cost__settings">
        <summary>{t("cost.details")}</summary>
        <CloudPriceSetting />
      </details>
    </section>
  );
}