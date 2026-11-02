/**
 * LlmTokenTotals — per-model cumulative prompt/completion token table.
 * Local-only component: lives in its own file, rendered by LlmPanel via one
 * anchor line + one import line (see docs/LOCAL-MODS.md).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchLlmTokenTotals } from "../../api/llmTokenClient";
import { formatTokensCompact } from "../../shared/tokenFormat";
import { formatSince } from "../../shared/formatSince";
import type { LlmTokenRange, LlmTokenSeriesTotals } from "../../api/llmTokenTypes";

const POLL_MS = 60_000;

const RANGE_ORDER: LlmTokenRange[] = ["all", "today", "6h", "1h", "7d", "14d", "30d"];

export function LlmTokenTotals({ sparkId, llmPort }: { sparkId: string; llmPort: number }) {
  const { t } = useTranslation("spark");
  const [series, setSeries] = useState<LlmTokenSeriesTotals[] | null>(null);
  const [range, setRange] = useState<LlmTokenRange>("all");

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchLlmTokenTotals(range)
        .then((res) => {
          if (!cancelled) setSeries(res.series || []);
        })
        .catch(() => {
          if (!cancelled) setSeries([]);
        });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sparkId, llmPort, range]);

  if (!series || series.length === 0) return null;

  const rows = series
    .filter((s) => s.sparkId === sparkId && s.port === llmPort)
    .flatMap((s) => s.models);

  if (rows.length === 0 && range === "all") return null;

  const rangeLabel = (value: LlmTokenRange): string => {
    switch (value) {
      case "all":
        return t("tokenTotals.rangeAll");
      case "today":
        return t("tokenTotals.rangeToday");
      case "6h":
        return t("tokenTotals.range6h");
      case "1h":
        return t("tokenTotals.range1h");
      case "7d":
        return t("tokenTotals.range7d");
      case "14d":
        return t("tokenTotals.range14d");
      default:
        return t("tokenTotals.range30d");
    }
  };

  return (
    <div className="sp-section">
      <div className="sp-section__head">
        <span className="min-w-0" title={t("tokenTotals.ledgerTooltip")}>
          <span className="eyebrow block">{t("tokenTotals.ledgerTitle")}</span>
          <span className="sp-muted block">{t("tokenTotals.ledgerHint")}</span>
        </span>
        <div className="flex items-center gap-2">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as LlmTokenRange)}
            aria-label={t("tokenTotals.rangeLabel")}
            className="sp-select"
          >
            {RANGE_ORDER.map((value) => (
              <option key={value} value={value}>
                {rangeLabel(value)}
              </option>
            ))}
          </select>
          <span className="sp-tok-cols">
            <span className="inline-block w-14 text-right">{t("tokenTotals.cachedColumn")}</span>

            <span className="inline-block w-14 text-right">{t("tokenTotals.prefillColumn")}</span>

            <span className="inline-block w-16 text-right">{t("tokenTotals.generatedColumn")}</span>
          </span>
        </div>
      </div>
      <div className="sp-tok-rows">
        {rows.length === 0 ? (
          <p className="sp-muted">{t("tokenTotals.empty")}</p>
        ) : (
          rows.map((row) => {
          const seen = formatSince(row.lastSeenAt);
          return (
            <div
              key={row.modelId}
              className="flex items-center justify-between gap-2 text-[11px]"
              title={`${t("tokenTotals.rowTitle", {
                prompt: row.promptTokens.toLocaleString(),
                cached: row.cachedTokens.toLocaleString(),
                prefill: (row.promptTokens - row.cachedTokens).toLocaleString(),
                generated: row.completionTokens.toLocaleString(),
              })}${seen ? t("tokenTotals.rowSeen", { since: seen }) : ""}`}
            >
              <span
                className="min-w-0 flex-1 truncate text-text"
                title={row.modelId}
              >
                {row.modelId}
              </span>
              <span className="shrink-0 font-tabular text-muted">
                <span className="inline-block w-14 text-right">
                  {row.cachedTokens > 0 ? formatTokensCompact(row.cachedTokens) : "—"}
                </span>

                <span className="inline-block w-14 text-right">
                  {formatTokensCompact(row.promptTokens - row.cachedTokens)}
                </span>

                <span className="inline-block w-16 text-right text-text">
                  {formatTokensCompact(row.completionTokens)}
                </span>
              </span>
            </div>
          );
        })
        )}
      </div>
    </div>
  );
}