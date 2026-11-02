import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchMonthlyEnergy } from "../../api/client";
import type { MonthlyEnergy as MonthlyEnergyData, MonthlyEnergyMonth } from "../../api/types";
import { StackedBarChart, type BarSeries } from "../ui/StackedBarChart";
import { Tag } from "../ui/Tag";
import { formatKwh, formatMoney, type Translate } from "./energyStats";
import {
  fleetCoverage,
  monthLabel,
  monthNodeRows,
  monthOptions,
  nodeColors,
  yearBars,
  yearOptions,
  yearTotalKwh,
} from "./monthlyStats";

const REFRESH_MS = 5 * 60_000;
const pct = (v: number) => `${(v * 100).toFixed(v >= 0.995 ? 0 : 1)}%`;

interface ViewProps {
  nameOf: (id: string) => string;
  colorOf: (id: string) => string;
  price: number | null;
  currency: string;
}

/** Permanent monthly totals: pick a month for per-node figures, or a year for twelve bars. */
export function MonthlyEnergy({
  nameOf,
  price,
  currency,
  reloadToken = 0,
}: {
  nameOf: (id: string) => string;
  price: number | null;
  currency: string;
  /** Change this value (e.g. after a Reset) to refetch immediately. */
  reloadToken?: number;
}) {
  const { t: translate } = useTranslation("energy");
  const t = translate as unknown as Translate;
  const locale = typeof document === "undefined" ? undefined : document.documentElement.lang || undefined;
  const [data, setData] = useState<MonthlyEnergyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"month" | "year">("month");
  const [month, setMonth] = useState<string | null>(null);
  const [year, setYear] = useState<number | null>(null);

  const load = useCallback(
    () =>
      fetchMonthlyEnergy()
        .then((next) => {
          setData(next);
          setError(null);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err))),
    []
  );
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);
  const lastToken = useRef(reloadToken);
  useEffect(() => {
    if (lastToken.current === reloadToken) return;
    lastToken.current = reloadToken;
    void load();
  }, [reloadToken, load]);

  const now = data?.generatedAt ?? 0;
  const months = useMemo(() => data?.months ?? [], [data]);
  const monthKeys = useMemo(() => monthOptions(months, now), [months, now]);
  const years = useMemo(() => yearOptions(months, now), [months, now]);
  const colorOf = useMemo(() => nodeColors(months), [months]);

  // Default to the newest month with data (or the current one), and this year.
  const activeMonth = month && monthKeys.includes(month) ? month : (months.at(-1)?.month ?? monthKeys[0]);
  const activeYear = year != null && years.includes(year) ? year : years[0];

  return (
    <section className="panel en-panel en-monthly" aria-labelledby="en-h-monthly">
      <header className="en-panel__head">
        <div>
          <h2 id="en-h-monthly">{t("monthly.title")}</h2>
          <p className="en-panel__sub">{t("monthly.subtitle")}</p>
        </div>
        {data && months.length > 0 ? (
          <div className="en-monthly__tools">
            <div className="seg" role="group" aria-label={t("monthly.viewAria")}>
              <button type="button" aria-pressed={view === "month"} className={view === "month" ? "is-on" : ""} onClick={() => setView("month")}>{t("monthly.month")}</button>
              <button type="button" aria-pressed={view === "year"} className={view === "year" ? "is-on" : ""} onClick={() => setView("year")}>{t("monthly.year")}</button>
            </div>
            {view === "month" ? (
              <select className="en-select" aria-label={t("monthly.month")} value={activeMonth} onChange={(e) => setMonth(e.target.value)}>
                {monthKeys.map((key) => <option key={key} value={key}>{monthLabel(key, locale)}</option>)}
              </select>
            ) : (
              <select className="en-select" aria-label={t("monthly.year")} value={activeYear} onChange={(e) => setYear(Number(e.target.value))}>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            )}
          </div>
        ) : null}
      </header>

      {error && !data ? (
        <p className="en-panel__sub" role="alert">{t("monthly.loadFailed", { message: error })}</p>
      ) : !data ? (
        <p className="en-panel__sub" role="status">{t("monthly.loading")}</p>
      ) : months.length === 0 ? (
        <p className="en-panel__sub" role="status">{t("monthly.empty")}</p>
      ) : view === "month" ? (
        <MonthView
          month={months.find((m) => m.month === activeMonth) ?? null}
          label={monthLabel(activeMonth, locale)}
          now={now}
          nameOf={nameOf}
          colorOf={colorOf}
          price={price}
          currency={currency}
        />
      ) : (
        <YearView months={months} year={activeYear} nameOf={nameOf} colorOf={colorOf} price={price} currency={currency} />
      )}
    </section>
  );
}

function MonthView({
  month,
  label,
  now,
  nameOf,
  colorOf,
  price,
  currency,
}: ViewProps & { month: MonthlyEnergyMonth | null; label: string; now: number }) {
  const { t } = useTranslation("energy");
  if (!month || month.totalWh <= 0) {
    return <p className="en-panel__sub" role="status">{t("monthly.noneInMonth", { month: label })}</p>;
  }
  const rows = monthNodeRows(month, now, price);
  const kwh = month.totalWh / 1000;
  const cost = price != null ? kwh * price : null;
  const eff = month.whPerOutputToken != null ? month.whPerOutputToken * 1000 : null;
  return (
    <>
      <div className="en-monthly__stats" role="group" aria-label={t("monthly.statsAria", { month: label })}>
        <div><span className="eyebrow">{t("monthly.energy")}</span><b className="mono">{formatKwh(kwh)} kWh</b></div>
        <div><span className="eyebrow">{t("monthly.cost")}</span><b className="mono">{cost != null ? formatMoney(cost, currency) : "—"}</b></div>
        <div>
          <span className="eyebrow">{t("monthly.efficiency")}</span>
          <b className="mono">{eff != null ? `${eff < 10 ? eff.toFixed(2) : eff.toFixed(1)} ${t("units.efficiency")}` : "—"}</b>
        </div>
        <div><span className="eyebrow">{t("monthly.fleetCoverage")}</span><b className="mono">{pct(fleetCoverage(month, now))}</b></div>
        <div>
          <span className="eyebrow">{t("monthly.status")}</span>
          <Tag tone={month.closed ? "good" : "warn"}>{month.closed ? t("monthly.closed") : t("monthly.open")}</Tag>
        </div>
      </div>
      <div className="en-table-wrap">
        <table className="en-table">
          <caption className="sr-only">{t("monthly.caption", { month: label })}</caption>
          <thead>
            <tr>
              <th scope="col" className="is-left">{t("nodes.spark")}</th>
              <th scope="col">{t("nodes.energy")}</th>
              <th scope="col">{t("nodes.share")}</th>
              <th scope="col">{t("nodes.coverage")}</th>
              <th scope="col">{t("nodes.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.id}>
                <th scope="row" className="en-table__name">
                  <i className="en-swatch" style={{ background: colorOf(n.id) }} aria-hidden="true" />
                  {nameOf(n.id)}
                </th>
                <td className="mono">{formatKwh(n.kwh)} kWh</td>
                <td className="mono">{pct(n.share)}</td>
                <td className="mono">{pct(n.coverage)}</td>
                <td className="mono">{n.cost != null ? formatMoney(n.cost, currency) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="en-panel__sub en-panel__foot">
        {t("monthly.footNote", { month: label, soFar: month.closed ? "" : t("monthly.soFar") })}
      </p>
    </>
  );
}

function YearView({
  months,
  year,
  nameOf,
  colorOf,
  price,
  currency,
}: ViewProps & { months: MonthlyEnergyMonth[]; year: number }) {
  const { t } = useTranslation("energy");
  const locale = typeof document === "undefined" ? undefined : document.documentElement.lang || undefined;
  const bars = yearBars(months, year, locale);
  const ids = [...new Set(bars.flatMap((b) => Object.keys(b.values)))];
  const series: BarSeries[] = ids.map((id) => ({ id, label: nameOf(id), color: colorOf(id) }));
  const total = yearTotalKwh(months, year);
  return (
    <>
      <p className="en-monthly__year">
        <b className="mono">{t("monthly.yearTotalKwh", { kwh: formatKwh(total) })}</b> {t("monthly.yearTotalIn", { year })}
        {price != null && total > 0 ? <span>{t("monthly.yearCost", { amount: formatMoney(total * price, currency) })}</span> : null}
      </p>
      <div className="legend" aria-label={t("energyPanel.legendAria")}>
        {series.map((s) => (
          <span key={s.id} style={{ "--c": s.color } as React.CSSProperties}>{s.label}</span>
        ))}
      </div>
      <StackedBarChart
        buckets={bars}
        series={series}
        height={220}
        format={formatKwh}
        unit="kWh"
        empty={t("monthly.emptyYear", { year })}
        ariaLabel={t("monthly.yearAria", { year })}
      />
    </>
  );
}