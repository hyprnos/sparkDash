import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SparkSnapshot } from "../../api/types";
import { StackedBarChart, type BarBucket, type BarSeries } from "../ui/StackedBarChart";
import { RotateIcon, SearchIcon, XIcon } from "../ui/icons";
import { EventRow } from "./EventRow";
import { ClearMenu } from "../ui/ClearMenu";
import {
  CATEGORIES, EMPTY_FILTER, NO_SPARK, SEVERITIES, categoryLabel, countByCategory, countBySeverity, countBySpark,
  eventsPerDay, exportText, filterEvents, groupByDay, isFilterActive, sparkOptions, summarize, severityLabel,
  type ActivityFilter, type CategoryId, type RangeId, type Severity, type Translate,
} from "./activityStats";
import { useActivityFeed } from "./useActivityFeed";
import "../../styles/activity.css";

const DAY_MS = 86_400_000;

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

function formatUpdated(ts: number | null, now: number, t: Translate): string {
  if (ts == null) return t("live.connecting");
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 5 ? t("live.justNow") : s < 60 ? t("live.secondsAgo", { count: s }) : t("live.minutesAgo", { count: Math.floor(s / 60) });
}

/** Fallback for browsers or contexts without the async clipboard API. */
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.className = "ac-offscreen";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function ActivityPage({ sparks, onSelectSpark }: { sparks: SparkSnapshot[]; onSelectSpark?: (id: string) => void }) {
  const { t, i18n } = useTranslation("activity");
  const tr = t as unknown as Translate;
  const locale = i18n.language;
  const [filter, setFilter] = useState<ActivityFilter>(EMPTY_FILTER);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const [copyMsg, setCopyMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const awayRef = useRef(false);

  const onArrive = useCallback((n: number) => {
    if (awayRef.current) setUnseen((c) => c + n);
  }, []);
  const feed = useActivityFeed(onArrive);
  const { events } = feed;

  // Clock for relative labels and the Today/Yesterday headings.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  // "Scrolled away" = the timeline's top edge has left the viewport (any scroll container).
  useEffect(() => {
    const check = () => {
      const top = topRef.current?.getBoundingClientRect().top ?? 0;
      const isAway = top < -120;
      awayRef.current = isAway;
      setAway(isAway);
      if (!isAway) setUnseen(0);
    };
    window.addEventListener("scroll", check, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", check, { capture: true });
  }, []);

  const toggle = useCallback((id: number) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const summary = useMemo(() => summarize(events, now), [events, now]);
  const buckets = useMemo(() => eventsPerDay(events, now, 14, undefined, locale), [events, now, locale]);
  const chartBuckets: BarBucket[] = useMemo(
    () => buckets.map((b) => ({ key: b.key, label: b.label, title: b.title, values: b.counts })),
    [buckets]
  );
  const visible = useMemo(() => filterEvents(events, filter, now, tr), [events, filter, now, tr]);
  const groups = useMemo(() => groupByDay(visible, now, undefined, tr, locale), [visible, now, tr, locale]);
  const sevCounts = useMemo(() => countBySeverity(events, filter, now), [events, filter, now]);
  const catCounts = useMemo(() => countByCategory(events, filter, now), [events, filter, now]);
  const sparkCounts = useMemo(() => countBySpark(events, filter, now), [events, filter, now]);
  const options = useMemo(() => sparkOptions(sparks, events), [sparks, events]);
  const hasNoSpark = (sparkCounts[NO_SPARK] ?? 0) > 0 || filter.sparkId === NO_SPARK;
  const active = isFilterActive(filter);
  const chartTotal = buckets.reduce((n, b) => n + b.counts.error + b.counts.warn + b.counts.success + b.counts.info, 0);

  const patch = (p: Partial<ActivityFilter>) => setFilter((f) => ({ ...f, ...p }));
  const preset = (p: Partial<ActivityFilter>) => setFilter({ ...EMPTY_FILTER, ...p });
  const toggleSeverity = (s: Severity) =>
    patch({ severities: filter.severities.includes(s) ? filter.severities.filter((x) => x !== s) : [...filter.severities, s] });

  const copyAll = async () => {
    const text = exportText(visible, undefined, tr);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text);
    }
    setCopyMsg({
      ok,
      text: ok
        ? visible.length === 1
          ? t("copy.doneOne", { count: visible.length })
          : t("copy.doneMany", { count: visible.length })
        : t("copy.failed"),
    });
    setTimeout(() => setCopyMsg(null), 2500);
  };

  const jumpToNewest = () => {
    rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    setUnseen(0);
  };

  const live = feed.pollError ? "warn" : feed.paused ? "off" : "ok";
  const liveText = feed.pollError
    ? t("live.failed")
    : feed.paused
      ? t("live.paused")
      : t("live.live", { when: formatUpdated(feed.lastUpdated, now, tr) });

  const clearChoices = [
    { id: "7d", label: t("clear.older7d"), ask: t("clear.ask7d"), arg: 7 * DAY_MS },
    { id: "24h", label: t("clear.older24h"), ask: t("clear.ask24h"), arg: DAY_MS },
    { id: "all", label: t("clear.everything"), ask: t("clear.askAll"), arg: undefined },
  ];

  const series: readonly BarSeries[] = [
    { id: "error", label: t("severity.errors"), color: "var(--color-danger)" },
    { id: "warn", label: t("severity.warnings"), color: "var(--color-warning)" },
    { id: "success", label: t("severity.successMany"), color: "var(--color-success)" },
    { id: "info", label: t("severity.infoMany"), color: "var(--color-info)" },
  ];

  const ranges: readonly { id: RangeId; label: string }[] = [
    { id: "24h", label: t("range.24h") },
    { id: "7d", label: t("range.7d") },
    { id: "all", label: t("range.all") },
  ];

  const sevChips: readonly { id: Severity; label: string }[] = [
    { id: "error", label: t("severity.errors") },
    { id: "warn", label: t("severity.warnings") },
    { id: "success", label: t("severity.successMany") },
    { id: "info", label: t("severity.infoMany") },
  ];

  const eventCount = (n: number) => (n === 1 ? t("tiles.eventsOne", { count: n }) : t("tiles.eventsMany", { count: n }));

  const tiles = [
    {
      id: "events",
      label: t("tiles.events24h"),
      value: String(summary.events24h),
      sub: t("tiles.in7d", { count: summary.events7d }),
      on: filter.range === "24h" && !filter.severities.length && filter.sparkId === "all" && filter.category === "all" && !filter.query,
      run: () => preset({ range: "24h" }),
    },
    {
      id: "errors",
      label: t("tiles.errors24h"),
      value: String(summary.errors24h),
      sub: t("tiles.in7d", { count: summary.errors7d }),
      tone: summary.errors24h > 0 ? "bad" : "",
      on: filter.range === "24h" && sameSet(filter.severities, ["error"]),
      run: () => preset({ range: "24h", severities: ["error"] }),
    },
    {
      id: "warnings",
      label: t("tiles.warnings24h"),
      value: String(summary.warnings24h),
      sub: t("tiles.in7d", { count: summary.warnings7d }),
      tone: summary.warnings24h > 0 ? "warn" : "",
      on: filter.range === "24h" && sameSet(filter.severities, ["warn"]),
      run: () => preset({ range: "24h", severities: ["warn"] }),
    },
    {
      id: "problems",
      label: t("tiles.problemSparks"),
      value: String(summary.problemSparks24h),
      sub: t("tiles.in7d", { count: summary.problemSparks7d }),
      tone: summary.problemSparks24h > 0 ? "warn" : "",
      on: filter.range === "24h" && sameSet(filter.severities, ["error", "warn"]),
      run: () => preset({ range: "24h", severities: ["error", "warn"] }),
    },
    {
      id: "active",
      label: t("tiles.mostActive"),
      value: summary.mostActive?.name ?? t("tiles.none"),
      small: true,
      sub: summary.mostActive ? eventCount(summary.mostActive.count) : t("tiles.noEvents"),
      on: summary.mostActive != null && filter.sparkId === summary.mostActive.sparkId,
      disabled: summary.mostActive == null,
      run: () => summary.mostActive && preset({ range: "24h", sparkId: summary.mostActive.sparkId }),
    },
  ];

  const timeline = (() => {
    if (feed.status === "loading") {
      return (
        <ul className="ac-skel" aria-busy="true" aria-label={t("timeline.loadingAria")}>
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i} className="ac-skel__row">
              <i className="ac-skel__bar ac-skel__bar--s" />
              <i className="ac-skel__bar ac-skel__bar--s" />
              <i className="ac-skel__bar" />
            </li>
          ))}
        </ul>
      );
    }
    if (feed.status === "error") {
      return (
        <div className="ac-state" role="alert">
          <h3>{t("timeline.loadFailedTitle")}</h3>
          <p>{feed.error}</p>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void feed.reload()}>
            {t("common.retry")}
          </button>
        </div>
      );
    }
    if (events.length === 0) {
      return (
        <div className="ac-state">
          <h3>{t("timeline.emptyTitle")}</h3>
          <p>{t("timeline.emptyBody")}</p>
        </div>
      );
    }
    if (visible.length === 0) {
      return (
        <div className="ac-state">
          <h3>{t("timeline.filteredTitle")}</h3>
          <p>{t("timeline.filteredBody")}</p>
          <button type="button" className="btn btn--sm" onClick={() => setFilter(EMPTY_FILTER)}>
            {t("filters.reset")}
          </button>
        </div>
      );
    }
    return (
      <div>
        {groups.map((g) => (
          <section key={g.key} className="ac-day" aria-label={g.label}>
            <h3 className="ac-day__head">
              <span>{g.label}</span>
              <span className="ac-day__count mono">{g.events.length}</span>
            </h3>
            <ul className="ac-list">
              {g.events.map((e) => (
                <EventRow
                  key={e.id}
                  event={e}
                  open={open.has(e.id)}
                  fresh={feed.fresh.has(e.id)}
                  now={now}
                  onToggle={toggle}
                  onSelectSpark={onSelectSpark}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  })();

  return (
    <div className="ac" ref={rootRef}>
      <header className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <p className="page-head__sub">{t("subtitle")}</p>
        </div>
        <div className="page-head__tools">
          <span className={`ac-live ac-live--${live}`} role="status">
            <i className="ac-live__dot" aria-hidden="true" />
            {liveText}
          </span>
          <button type="button" className="btn btn--sm" onClick={() => void feed.refresh()} disabled={feed.status !== "ready" || feed.refreshing}>
            <RotateIcon className={`h-3.5 w-3.5${feed.refreshing ? " ac-spin" : ""}`} />
            {t("refresh")}
          </button>
          <button type="button" className="btn btn--sm" onClick={() => void copyAll()} disabled={visible.length === 0}>
            {t("copy.asText")}
          </button>
          <ClearMenu
            label={t("clear.menu")}
            note={t("clear.note")}
            choices={clearChoices}
            onRun={feed.clear}
            disabled={feed.status !== "ready"}
          />
          <span className={`ac-toast${copyMsg ? (copyMsg.ok ? " is-ok" : " is-err") : ""}`} role="status" aria-live="polite">
            {copyMsg?.text}
          </span>
        </div>
      </header>

      <div className="ac-tiles" role="group" aria-label={t("tiles.summaryAria")}>
        {tiles.map((tile) => (
          <button
            key={tile.id}
            type="button"
            className={`panel ac-tile${tile.on ? " is-on" : ""}${tile.tone ? ` ac-tile--${tile.tone}` : ""}`}
            aria-pressed={tile.on}
            disabled={tile.disabled || feed.status !== "ready"}
            onClick={tile.run}
          >
            <span className="eyebrow">{tile.label}</span>
            <span className={`ac-tile__val${tile.small ? " ac-tile__val--text" : " big-num"}`}>{tile.value}</span>
            <span className="ac-tile__sub">{tile.sub}</span>
          </button>
        ))}
      </div>

      <section className="panel ac-chart" aria-label={t("chart.title")}>
        <div className="ac-chart__head">
          <h2 className="panel-title">{t("chart.title")}</h2>
          <ul className="ac-legend">
            {series.map((s) => (
              <li key={s.id}>
                <i className={`ac-sev__dot ac-sev__dot--${s.id}`} aria-hidden="true" />
                {s.label}
              </li>
            ))}
          </ul>
        </div>
        <StackedBarChart
          buckets={chartBuckets}
          series={series}
          height={150}
          format={(n) => String(Math.round(n))}
          unit={t("chart.unit")}
          empty={feed.status === "ready" ? t("chart.empty") : t("common.loading")}
          ariaLabel={t("chart.ariaLabel", { count: chartTotal })}
        />
      </section>

      <section className="panel ac-filters" aria-label={t("filters.aria")}>
        <div className="ac-filters__row">
          <div className="ac-chips" role="group" aria-label={t("filters.severity")}>
            <button type="button" className="ac-chip" aria-pressed={filter.severities.length === 0} onClick={() => patch({ severities: [] })}>
              {t("filters.all")} <b className="mono">{SEVERITIES.reduce((n, s) => n + sevCounts[s], 0)}</b>
            </button>
            {sevChips.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`ac-chip ac-chip--${c.id}`}
                aria-pressed={filter.severities.includes(c.id)}
                onClick={() => toggleSeverity(c.id)}
                title={t("filters.severityTitle", { severity: severityLabel(c.id, tr) })}
              >
                <i className={`ac-sev__dot ac-sev__dot--${c.id}`} aria-hidden="true" />
                {c.label} <b className="mono">{sevCounts[c.id]}</b>
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label={t("filters.timeRange")}>
            {ranges.map((r) => (
              <button key={r.id} type="button" aria-pressed={filter.range === r.id} onClick={() => patch({ range: r.id })}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <div className="ac-filters__row">
          <label className="ac-search">
            <SearchIcon className="h-4 w-4" />
            <input
              type="search"
              value={filter.query}
              onChange={(e) => patch({ query: e.target.value })}
              placeholder={t("filters.searchPlaceholder")}
              aria-label={t("filters.searchAria")}
            />
          </label>
          <label className="ac-select">
            <span className="eyebrow">{t("filters.category")}</span>
            <select value={filter.category} onChange={(e) => patch({ category: e.target.value as CategoryId | "all" })}>
              <option value="all">{t("filters.allCategories")}</option>
              {CATEGORIES.filter((c) => catCounts[c.id] > 0 || filter.category === c.id).map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryLabel(c.id, tr)} ({catCounts[c.id]})
                </option>
              ))}
            </select>
          </label>
          <label className="ac-select">
            <span className="eyebrow">{t("filters.spark")}</span>
            <select value={filter.sparkId} onChange={(e) => patch({ sparkId: e.target.value })}>
              <option value="all">{t("filters.allSparks")}</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({sparkCounts[o.id] ?? 0})
                </option>
              ))}
              {hasNoSpark ? <option value={NO_SPARK}>{t("filters.fleetWide", { count: sparkCounts[NO_SPARK] ?? 0 })}</option> : null}
            </select>
          </label>
          <button type="button" className="btn btn--ghost btn--sm ac-reset" onClick={() => setFilter(EMPTY_FILTER)} disabled={!active}>
            <XIcon className="h-3.5 w-3.5" />
            {t("filters.reset")}
          </button>
        </div>
      </section>

      <div className="ac-count" role="status" aria-live="polite">
        {feed.status === "ready" ? (
          <>
            {active ? t("count.showingFiltered", { visible: visible.length, total: events.length }) : t("count.showing", { visible: visible.length, total: events.length })}
          </>
        ) : (
          " "
        )}
      </div>

      <div ref={topRef} />
      {away && unseen > 0 ? (
        <div className="ac-newbar">
          <button type="button" className="btn btn--primary btn--sm" onClick={jumpToNewest}>
            {unseen === 1 ? t("newBar.one", { count: unseen }) : t("newBar.many", { count: unseen })}
          </button>
        </div>
      ) : null}

      <div className="panel ac-timeline">{timeline}</div>

      {feed.status === "ready" && events.length > 0 ? (
        <div className="ac-more">
          {feed.reachedOldest ? (
            <p className="ac-more__end">{t("more.reachedOldest")}</p>
          ) : (
            <>
              <button type="button" className="btn btn--sm" onClick={() => void feed.loadOlder()} disabled={feed.loadingMore}>
                {feed.loadingMore ? t("common.loading") : t("more.loadOlder")}
              </button>
              {active ? <p className="ac-more__hint">{t("more.filtersHint")}</p> : null}
              {feed.moreError ? (
                <p className="ac-more__err" role="alert">
                  {t("more.loadFailed", { message: feed.moreError })}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default ActivityPage;