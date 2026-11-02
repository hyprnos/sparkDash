import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchTokenHistory } from "../../api/client";
import { fetchLlmTokenTotals } from "../../api/llmTokenClient";
import { fetchModelPrices } from "../../api/costClient";
import type { ModelPrice } from "../../api/costTypes";
import type { TokenHistory, TokenHistoryRow } from "../../api/types";
import { formatTokensCompact } from "../../shared/tokenFormat";
import { StackedBarChart, type BarBucket, type BarSeries } from "../ui/StackedBarChart";
import {
  RANGES,
  bucketLabel,
  bucketTitle,
  entriesFromTotals,
  rowsIn,
  tallyOf,
  trackedBuckets,
  windowFor,
  type Entry,
  type RangeKey,
  type Tally,
  type Translate,
} from "../TokensPage/tokenStats";
import { blendedPerMillion, costBuckets, costOf, filterModels, fmtMoney, priceLabel } from "./costStats";
import "../../styles/tokens.css";
import "../../styles/cost.css";

const POLL_MS = 30_000;
const fmt = formatTokensCompact;
const MODEL_KEY = "sparkdash.cost.model";

/** Catalog copy for a range tab: its tab label and the phrase sentences use. */
interface RangeCopy {
  label: string;
  phrase: string;
}

/** One static catalog key per range, so every tab is translated without dynamic keys. */
function rangeCopies(t: Translate): Record<RangeKey, RangeCopy> {
  return {
    today: { label: t("range.today.label"), phrase: t("range.today.phrase") },
    week: { label: t("range.week.label"), phrase: t("range.week.phrase") },
    month: { label: t("range.month.label"), phrase: t("range.month.phrase") },
    "24h": { label: t("range.24h.label"), phrase: t("range.24h.phrase") },
    "7d": { label: t("range.7d.label"), phrase: t("range.7d.phrase") },
    "14d": { label: t("range.14d.label"), phrase: t("range.14d.phrase") },
    "30d": { label: t("range.30d.label"), phrase: t("range.30d.phrase") },
    all: { label: t("range.all.label"), phrase: t("range.all.phrase") },
  };
}

interface Usage {
  history: TokenHistory;
  /** Lifetime totals per model; null when that endpoint failed (All time then falls back to retained days). */
  lifetime: Entry[] | null;
}

interface Prices {
  models: ModelPrice[];
  at: number | null;
  stale: boolean;
}

export function CostPage() {
  const { t: translate } = useTranslation("cost");
  const t = translate as unknown as Translate;
  const [range, setRange] = useState<RangeKey>("7d");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [prices, setPrices] = useState<Prices | null>(null);
  const [pricesError, setPricesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [modelId, setModelId] = useState<string>(() => {
    try {
      return localStorage.getItem(MODEL_KEY) || "";
    } catch {
      return "";
    }
  });

  // Usage polls; prices load once (and on retry) so a slow or dead price source
  // never holds the usage view hostage.
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      Promise.all([
        fetchTokenHistory(),
        fetchLlmTokenTotals("all")
          .then((r) => r.series || [])
          .catch(() => null),
      ])
        .then(([history, lifetimeSeries]) => {
          if (cancelled) return;
          setUsage({ history, lifetime: lifetimeSeries ? entriesFromTotals(lifetimeSeries) : null });
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
    let cancelled = false;
    fetchModelPrices()
      .then((res) => {
        if (cancelled) return;
        setPrices({ models: res.models ?? [], at: res.fetchedAt ?? null, stale: res.stale ?? false });
        setPricesError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setPricesError(e instanceof Error ? e.message : t("priceLoadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [tick, t]);

  const selectModel = useCallback((id: string) => {
    setModelId(id);
    try {
      localStorage.setItem(MODEL_KEY, id);
    } catch {
      /* private mode: the pick just does not survive a reload */
    }
  }, []);

  const price = useMemo(() => prices?.models.find((m) => m.id === modelId) ?? null, [prices, modelId]);

  const view = useMemo(() => {
    if (!usage || !price) return null;
    const { history, lifetime } = usage;
    const at = Date.now();
    const w = windowFor(range, history, at);
    const inRange: TokenHistoryRow[] = rowsIn(w.spec.unit === "hour" ? history.hour : history.day, w.keys);
    const useLifetime = range === "all" && lifetime != null;
    const priced: readonly Entry[] = useLifetime ? lifetime : inRange;
    // Days the average is spread over: the range length, or — All time — every
    // day tracking has recorded (the Token totals rule), not a fixed 30.
    const days =
      w.spec.count ?? (useLifetime ? trackedBuckets(w.firstKey, "day", at) ?? w.keys.length : w.keys.length);
    return {
      w,
      inRange,
      days,
      cost: costOf(priced, price),
      tally: tallyOf(priced),
      buckets: costBuckets(inRange, w.keys, price),
      useLifetime,
    };
  }, [usage, range, price]);

  const spec = RANGES.find((r) => r.key === range) ?? RANGES[1];
  const copy = rangeCopies(t)[spec.key];
  const unitWord = spec.unit === "hour" ? t("units.hour") : t("units.day");
  const locale = document.documentElement.lang || undefined;

  const series: BarSeries[] = [
    { id: "input", label: t("chart.seriesInput"), color: "var(--color-accent)" },
    { id: "output", label: t("chart.seriesOutput"), color: "var(--color-violet)" },
  ];
  const chartBuckets: BarBucket[] = (view?.buckets ?? []).map((b) => ({
    key: b.key,
    label: bucketLabel(b.key, spec.unit, undefined, { locale }),
    title: bucketTitle(b.key, spec.unit, undefined, false, {
      locale,
      utc: t("chart.utc"),
      local: t("chart.local"),
    }),
    values: { input: b.input, output: b.output },
  }));

  return (
    <div className="tk cp">
      <header className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <p className="page-head__sub">{t("subtitle")}</p>
        </div>
      </header>

      {error ? (
        <div className="panel tk-note tk-note--err" role="alert">
          <span>{usage ? t("refreshFailed", { message: error }) : t("loadFailed", { message: error })}</span>
          <button type="button" className="btn btn--sm" onClick={() => setTick((value) => value + 1)}>
            {t("retry")}
          </button>
        </div>
      ) : null}

      <section className="panel tk-card" aria-labelledby="cp-pick-title">
        <div className="tk-card__head">
          <div>
            <h2 id="cp-pick-title" className="tk-card__title">
              {t("pricedAs")}
            </h2>
            {price ? <PriceLine price={price} /> : <p className="tk-card__sub">{t("pricedAsSub")}</p>}
          </div>
          <ModelPicker models={prices?.models ?? []} selectedId={price?.id ?? null} onSelect={selectModel} />
        </div>
      </section>

      {view && price ? (
        <>
          <CostTiles cost={view.cost} tally={view.tally} range={spec} days={view.days} />

          <section className="panel tk-card" aria-labelledby="cp-chart-title">
            <div className="tk-card__head">
              <div>
                <h2 id="cp-chart-title" className="tk-card__title">
                  {t("chart.title", { unit: unitWord })}
                </h2>
                <p className="tk-card__sub">
                  {t("chart.sub", { period: copy.phrase, model: price.id })}
                  {view.useLifetime ? t("chart.subLifetime") : ""}
                </p>
              </div>
              <div className="tk-card__tools">
                <div className="seg" role="group" aria-label={t("rangeGroup")}>
                  {RANGES.map((r) => (
                    <button
                      key={r.key}
                      type="button"
                      className={r.key === range ? "is-on" : undefined}
                      aria-pressed={r.key === range}
                      onClick={() => setRange(r.key)}
                    >
                      {rangeCopies(t)[r.key].label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <StackedBarChart
              buckets={chartBuckets}
              series={series}
              height={240}
              format={fmtMoney}
              unit={t("chart.unit")}
              empty={t("chart.empty")}
              ariaLabel={t("chart.aria", { unit: unitWord, model: price.id })}
            />
            <ul className="legend tk-legend">
              {series.map((s) => (
                <li key={s.id} style={{ "--c": s.color } as React.CSSProperties}>
                  <span>{s.label}</span>
                  <em className="mono">{fmtMoney(s.id === "input" ? view.cost.inputCost : view.cost.outputCost)}</em>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel tk-card tk-about" aria-labelledby="cp-about-title">
            <h2 id="cp-about-title" className="tk-card__title">
              {t("pricing.title")}
            </h2>
            <ul>
              <li>
                {t("pricing.inputRate", {
                  inputRate: fmtMoney(price.inputCostPerToken * 1_000_000),
                  outputRate: fmtMoney(price.outputCostPerToken * 1_000_000),
                })}
              </li>
              <li>
                {price.cacheReadCostPerToken != null
                  ? t("pricing.cachedRate", {
                      rate: fmtMoney(price.cacheReadCostPerToken * 1_000_000),
                      savings: fmtMoney(view.cost.cacheSavings),
                      period: copy.phrase,
                    })
                  : t("pricing.noCacheRate")}
              </li>
              <li>
                {t("pricing.sourceBefore")}{" "}
                <a
                  href="https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("pricing.sourceLink")}
                </a>
                {t("pricing.sourceAfter", {
                  fetched: prices?.at ? t("pricing.fetched", { when: new Date(prices.at).toLocaleString(locale) }) : "",
                  stale: prices?.stale ? t("pricing.stale") : "",
                })}
              </li>
              <li>{t("pricing.counters")}</li>
            </ul>
          </section>
        </>
      ) : usage ? (
        pricesError ? (
          <div className="panel tk-note tk-note--err" role="status">
            <b>{t("priceCatalogFailed")}</b> {pricesError}
            <button type="button" className="btn btn--sm" onClick={() => setTick((value) => value + 1)}>
              {t("retry")}
            </button>
          </div>
        ) : prices && prices.models.length === 0 ? (
          <div className="panel tk-note" role="status">
            <b>{t("pricesEmpty")}</b> {t("pricesEmptyHint")}
            <button type="button" className="btn btn--sm" onClick={() => setTick((value) => value + 1)}>{t("retry")}</button>
          </div>
        ) : prices ? (
          <div className="panel tk-note" role="status">{t("chooseModelCompare")}</div>
        ) : (
          <div className="panel tk-note" role="status">
            {t("loadingPrices")}
          </div>
        )
      ) : (
        <div className="panel tk-note" role="status">
          {t("loading")}
        </div>
      )}
    </div>
  );
}

function PriceLine({ price }: { price: ModelPrice }) {
  const { t } = useTranslation("cost");
  const ctx = [
    price.provider,
    price.maxInputTokens
      ? t("contextK", { count: Math.round(price.maxInputTokens / 1000).toLocaleString("en-US") })
      : null,
  ].filter(Boolean);
  return (
    <p className="tk-card__sub">
      <span className="mono">{price.id}</span>
      {ctx.length ? ` · ${ctx.join(" · ")}` : ""} · {priceLabel(price, t as unknown as Translate)}
    </p>
  );
}

function CostTiles({
  cost,
  tally,
  range,
  days,
}: {
  cost: { inputCost: number; outputCost: number; cacheSavings: number; totalCost: number };
  tally: Tally;
  range: (typeof RANGES)[number];
  /** Buckets the per-day average is spread over (All time: every tracked day). */
  days: number;
}) {
  const { t: translate } = useTranslation("cost");
  const t = translate as unknown as Translate;
  const copy = rangeCopies(t)[range.key];
  const unit = range.unit === "hour" ? t("units.hour") : t("units.day");
  const blended = blendedPerMillion(cost.totalCost, tally.total);
  const outputShare = cost.totalCost > 0 ? cost.outputCost / cost.totalCost : 0;
  return (
    <section className="tk-tiles" aria-label={t("tiles.summaryAria", { period: copy.phrase })}>
      <Tile
        label={t("tiles.total")}
        value={fmtMoney(cost.totalCost)}
        sub={t("tiles.totalSub", { period: copy.phrase })}
        title={cost.totalCost.toFixed(6)}
      />
      <Tile
        label={t("tiles.input")}
        value={fmtMoney(cost.inputCost)}
        sub={t("tiles.inputSub", { prompt: fmt(tally.prompt), cached: fmt(tally.cached) })}
        title={cost.inputCost.toFixed(6)}
      />
      <Tile
        label={t("tiles.output")}
        value={fmtMoney(cost.outputCost)}
        sub={t("tiles.outputSub", { tokens: fmt(tally.generated), share: (outputShare * 100).toFixed(0) })}
        title={cost.outputCost.toFixed(6)}
      />
      <Tile
        label={t("tiles.cacheSavings")}
        value={cost.cacheSavings > 0 ? fmtMoney(cost.cacheSavings) : "—"}
        sub={cost.cacheSavings > 0 ? t("tiles.cacheSavingsSub") : t("tiles.cacheSavingsNone")}
      />
      <Tile
        label={t("tiles.average", { unit })}
        value={fmtMoney(cost.totalCost / Math.max(1, days))}
        unit={t("tiles.averageUnit", { unit })}
        sub={t("tiles.averageSub", {
          count: days,
          unit: days === 1 ? unit : range.unit === "hour" ? t("units.hours") : t("units.days"),
          tracked: range.count == null ? t("tiles.tracked") : "",
        })}
      />
      <Tile
        label={t("tiles.blended")}
        value={blended == null ? "—" : `$${blended.toFixed(2)}`}
        unit={t("tiles.blendedUnit")}
        sub={t("tiles.blendedSub", { tokens: fmt(tally.total) })}
      />
    </section>
  );
}

function Tile({ label, value, unit, sub, title }: { label: string; value: string; unit?: string; sub?: string; title?: string }) {
  return (
    <div className="tk-tile" title={title}>
      <span className="eyebrow">{label}</span>
      <div className="big-num">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {sub ? <p className="tk-tile__sub">{sub}</p> : null}
    </div>
  );
}

/** Searchable dropdown over the whole catalog (thousands of chat models). */
function ModelPicker({
  models,
  selectedId,
  onSelect,
}: {
  models: ModelPrice[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("cost");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selected = models.find((m) => m.id === selectedId) ?? null;
  const results = useMemo(() => filterModels(models, query), [models, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setActive(0);
  }, [open]);

  const pick = (m: ModelPrice) => {
    onSelect(m.id);
    setOpen(false);
  };

  return (
    <div className="cp-picker" ref={rootRef}>
      <button type="button" className="cp-toggle" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="cp-toggle__id">{selected ? selected.id : t("chooseModel")}</span>
        {selected ? <span className="cp-toggle__price">{priceLabel(selected, t as unknown as Translate)}</span> : null}
      </button>
      {open ? (
        <div className="cp-pop" role="listbox" aria-label={t("catalogAria")}>
          <div className="cp-search">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                else if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, results.length - 1));
                else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
                else if (e.key === "Enter") {
                  const m = results[active];
                  if (m) pick(m);
                  e.preventDefault();
                }
              }}
              placeholder={t("searchPlaceholder", { count: models.length })}
              aria-label={t("searchAria")}
            />
          </div>
          <ul className="cp-list">
            {results.map((m, i) => (
              <li key={m.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={m.id === selectedId}
                  className={`cp-item${i === active ? " is-active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(m)}
                >
                  <span className="cp-item__id">{m.id}</span>
                  <span className="cp-item__meta">{priceLabel(m, t as unknown as Translate)}</span>
                </button>
              </li>
            ))}
            {results.length === 0 ? <li className="cp-empty">{t("noMatch", { query })}</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}