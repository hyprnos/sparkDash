import { useTranslation } from "react-i18next";
import { AppLink } from "../ui/AppLink";
import { activeTimeZone } from "../../shared/timeZone";
import { ACTIVITY_ID, idToPath } from "../../constants";
import { useActivityEvents } from "../../hooks/useActivityEvents";
import { formatRelativeTime, severityDotClass, splitMessage } from "./activityFormat";

interface ActivityFeedProps {
  limit?: number;
  sparkId?: string;
  onSelectSpark?: (sparkId: string) => void;
  /** Opens the full Activity page. */
  onViewAll?: () => void;
}

/** Screen-reader wording for an event severity (the raw value stays in the data model). */
function severityLabel(t: (key: string) => string, severity: string): string {
  switch (severity) {
    case "success":
      return t("activity.severitySuccess");
    case "warn":
      return t("activity.severityWarn");
    case "error":
      return t("activity.severityError");
    case "info":
      return t("activity.severityInfo");
    default:
      return t("activity.severityOther");
  }
}

/** Compact fleet timeline. Renders card contents only (no outer chrome). */
export function ActivityFeed({ limit = 8, sparkId, onSelectSpark, onViewAll }: ActivityFeedProps) {
  const { t, i18n } = useTranslation("overview");
  const { events, loading, error } = useActivityEvents({ sparkId });
  const now = Date.now();
  const shown = events.slice(0, limit);

  return (
    <section className="activity-feed" aria-label={t("activity.title")}>
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-strong">{t("activity.title")}</h3>
        <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
          {t("activity.live")}
        </span>
      </header>

      {loading && shown.length === 0 ? (
        <p className="py-2 text-xs text-muted">{t("activity.loading")}</p>
      ) : shown.length === 0 ? (
        <p className="py-2 text-xs text-muted">
          {error ? t("activity.error") : t("activity.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((ev) => {
            const { before, name, after } = splitMessage(ev.message, ev.sparkName);
            const clickable = Boolean(name && ev.sparkId && onSelectSpark);
            return (
              <li key={ev.id} className="flex items-baseline gap-2 py-1.5 text-xs">
                <time
                  className="w-10 shrink-0 text-right font-mono tabular-nums text-muted"
                  dateTime={new Date(ev.ts).toISOString()}
                  title={new Date(ev.ts).toLocaleString(undefined, { timeZone: activeTimeZone() })}
                >
                  {formatRelativeTime(ev.ts, now, { locale: i18n.language, now: t("activity.agoNow") })}
                </time>
                <span
                  className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${severityDotClass(ev.severity)}`}
                  aria-label={severityLabel(t, ev.severity)}
                />
                <span className="min-w-0 break-words text-muted-strong">
                  {before}
                  {name &&
                    (clickable ? (
                      <AppLink
                        href={idToPath(ev.sparkId as string)}
                        className="font-semibold text-text-strong hover:underline"
                        onNavigate={() => onSelectSpark!(ev.sparkId as string)}
                      >
                        {name}
                      </AppLink>
                    ) : (
                      <strong className="font-semibold text-text-strong">{name}</strong>
                    ))}
                  {after}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {onViewAll ? (
        <AppLink href={idToPath(ACTIVITY_ID)} className="btn btn--sm btn--ghost mt-2" onNavigate={onViewAll}>
          {t("activity.viewAll")}
        </AppLink>
      ) : null}
    </section>
  );
}

export default ActivityFeed;
