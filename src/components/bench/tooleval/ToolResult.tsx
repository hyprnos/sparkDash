import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Ring } from "../../ui/Ring";
import { Tag } from "../../ui/Tag";
import { GenericValue } from "./GenericResult";
import { fmtDuration, fmtNum, scoreTier, toneColor, type Translate } from "./format";
import { categoryNames, type NormScenario, type NormToolResult, type ScenarioStatus } from "./normalize";
import { JsonDisclosure } from "./parts";

const STATUS_TONE: Record<ScenarioStatus, "good" | "warn" | "bad" | "neutral"> = { pass: "good", partial: "warn", fail: "bad", other: "neutral" };
const STATUS_RANK: Record<ScenarioStatus, number> = { fail: 0, partial: 1, other: 2, pass: 3 };
const SHOWN_KEYS = new Set(["scenario_id", "id", "title", "category", "status", "points", "max_points", "duration_seconds", "reasoning"]);

type SortKey = "order" | "worst" | "id" | "points" | "duration";

export function Stars({ n, max = 5, label }: { n: number; max?: number; label?: string }) {
  return (
    <span className="te-stars" role="img" aria-label={label ?? `${n} of ${max} stars`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < n ? "is-on" : undefined} aria-hidden>
          ★
        </span>
      ))}
    </span>
  );
}

/** Headline, safety, categories and scenarios of a tool-call result. */
export function ToolResult({ data, raw }: { data: NormToolResult; raw: unknown }) {
  const { t: translate } = useTranslation("bench");
  const t = translate as unknown as Translate;
  const categories = categoryNames(t);
  const tier = scoreTier(data.score, t);
  const ratingStars = (data.rating?.match(/★/g) ?? []).length || tier?.stars || 0;
  const done = data.counts.pass + data.counts.partial + data.counts.fail + data.counts.other;
  return (
    <div className="te-toolresult">
      <section className="te-headline">
        <Ring
          value={data.score ?? 0}
          size={132}
          strokeWidth={11}
          color={toneColor(data.safety.length ? "warn" : (tier?.tone ?? "neutral"))}
          label={data.score != null ? fmtNum(data.score, 1) : "–"}
          caption={t("te.tool.finalScore")}
        />
        <div className="te-headline__main">
          <div className="te-headline__rating">
            {ratingStars ? <Stars n={ratingStars} label={t("te.tool.starsAria", { n: ratingStars, max: 5 })} /> : null}
            <b>{data.rating?.replace(/[★☆]+/g, "").trim() || tier?.label || t("te.tool.unrated")}</b>
          </div>
          <p className="te-faint">
            {data.safety.length ? t("te.tool.ratingCapped") : ""}
            {t("te.tool.tiers")}
          </p>
          <div className="te-tiles">
            <Tile label={t("te.tool.deployability")} value={data.deployability} suffix="/100" />
            <Tile label={t("te.tool.responsiveness")} value={data.responsiveness} suffix="/100" />
            <div className="te-tile">
              <span className="eyebrow">{t("te.tool.completion")}</span>
              <b className="big-num">
                {done}
                <small>/ {data.total ?? done} {t("te.tool.scenarios")}</small>
              </b>
              <span className="te-counters te-counters--tight">
                <span className="te-counter-chip is-pass"><b>{data.counts.pass}</b> {t("te.tool.pass")}</span>
                <span className="te-counter-chip is-partial"><b>{data.counts.partial}</b> {t("te.tool.partial")}</span>
                <span className="te-counter-chip is-fail"><b>{data.counts.fail}</b> {t("te.tool.fail")}</span>
              </span>
            </div>
          </div>
          <p className="te-faint te-meta-line">
            {data.model ? <>{t("te.tool.model")} <b className="mono">{data.model}</b> · </> : null}
            {data.backend ? <>{data.backend} · </> : null}
            {data.version ? <>tool-eval-bench {data.version} · </> : null}
            {data.runId ? <>{t("te.tool.runId")} <span className="mono">{data.runId}</span></> : null}
          </p>
        </div>
      </section>

      {data.safety.length ? (
        <section className="te-safety" role="alert" aria-label={t("te.tool.safetyAria")}>
          <h3>{t("te.tool.safetyTitle", { count: data.safety.length })}</h3>
          <ul>
            {data.safety.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.categories.length ? <Categories data={data} categories={categories} t={t} /> : null}
      {data.scenarios.length ? <Scenarios scenarios={data.scenarios} categories={categories} /> : null}

      {Object.keys(data.config).length ? (
        <details className="te-disclosure">
          <summary>
            <span>{t("te.tool.configUsed")}</span>
          </summary>
          <div className="te-disclosure__body">
            <GenericValue value={data.config} />
          </div>
        </details>
      ) : null}
      <JsonDisclosure value={raw} />
    </div>
  );
}

function Tile({ label, value, suffix }: { label: string; value: number | null; suffix?: string }) {
  const { t: translate } = useTranslation("bench");
  const t = translate as unknown as Translate;
  const tier = scoreTier(value, t);
  return (
    <div className="te-tile">
      <span className="eyebrow">{label}</span>
      <b className="big-num">
        {value != null ? fmtNum(value, 1) : "–"}
        {value != null && suffix ? <small>{suffix}</small> : null}
      </b>
      {tier ? <Tag tone={tier.tone}>{tier.label}</Tag> : null}
    </div>
  );
}

function Categories({ data, categories, t }: { data: NormToolResult; categories: Record<string, string>; t: Translate }) {
  return (
    <section className="te-section">
      <h3>{t("te.tool.categoryScores")}</h3>
      <ul className="te-catbars">
        {data.categories.map((c) => {
          const pct = c.percent == null ? null : Math.max(0, Math.min(100, c.percent));
          const name = c.name ?? categories[c.id] ?? null;
          const tier = scoreTier(pct, t);
          return (
            <li key={c.id} title={c.name ? undefined : name ? t("te.tool.categoryNameFromDocs") : undefined}>
              <span className="te-catbars__id">{c.id}</span>
              <span className="te-catbars__name">{name ?? t("te.tool.categoryFallback")}</span>
              <span
                className="te-catbars__track"
                role="img"
                aria-label={`${c.id}: ${pct == null ? t("te.tool.noScore") : t("te.tool.percentAria", { value: Math.round(pct) })}`}
              >
                <i style={pct != null ? { width: `${pct}%`, background: toneColor(tier?.tone ?? "neutral") } : undefined} />
              </span>
              <span className="te-catbars__val mono">{pct != null ? `${Math.round(pct)}%` : "–"}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Scenarios({ scenarios, categories }: { scenarios: NormScenario[]; categories: Record<string, string> }) {
  const { t: translate } = useTranslation("bench");
  const t = translate as unknown as Translate;
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | ScenarioStatus>("all");
  const [cat, setCat] = useState("all");
  const [sort, setSort] = useState<SortKey>("order");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(150);
  const cats = useMemo(() => [...new Set(scenarios.map((s) => s.category).filter((c): c is string => Boolean(c)))].sort(), [scenarios]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = scenarios.filter((s) => (status === "all" || s.status === status) && (cat === "all" || s.category === cat) && (!needle || `${s.id} ${s.title ?? ""} ${s.reasoning ?? ""}`.toLowerCase().includes(needle)));
    const by: Record<SortKey, ((a: NormScenario, b: NormScenario) => number) | null> = {
      order: null,
      worst: (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status],
      id: (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }),
      points: (a, b) => (a.points ?? -1) - (b.points ?? -1),
      duration: (a, b) => (b.durationSeconds ?? -1) - (a.durationSeconds ?? -1),
    };
    const fn = by[sort];
    return fn ? [...list].sort(fn) : list;
  }, [scenarios, q, status, cat, sort]);
  const toggle = (id: string) => setOpen((p) => (p.has(id) ? new Set([...p].filter((x) => x !== id)) : new Set(p).add(id)));

  return (
    <section className="te-section">
      <h3>
        {t("te.tool.scenariosTitle")}{" "}
        <span className="te-faint">
          ({rows.length === scenarios.length ? scenarios.length : t("te.tool.scenariosOf", { shown: rows.length, total: scenarios.length })})
        </span>
      </h3>
      <div className="te-filters">
        <input type="search" aria-label={t("te.tool.searchAria")} placeholder={t("te.tool.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label={t("te.tool.filterStatusAria")} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="all">{t("te.tool.statusAll")}</option>
          <option value="fail">{t("te.tool.statusFailed")}</option>
          <option value="partial">{t("te.tool.statusPartial")}</option>
          <option value="pass">{t("te.tool.statusPassed")}</option>
          <option value="other">{t("te.tool.statusOther")}</option>
        </select>
        {cats.length > 1 ? (
          <select aria-label={t("te.tool.filterCategoryAria")} value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="all">{t("te.tool.allCategories")}</option>
            {cats.map((c) => (
              <option key={c} value={c}>
                {c}
                {categories[c] ? ` · ${categories[c]}` : ""}
              </option>
            ))}
          </select>
        ) : null}
        <select aria-label={t("te.tool.sortAria")} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="order">{t("te.tool.sortOrder")}</option>
          <option value="worst">{t("te.tool.sortWorst")}</option>
          <option value="id">{t("te.tool.sortId")}</option>
          <option value="points">{t("te.tool.sortPoints")}</option>
          <option value="duration">{t("te.tool.sortSlowest")}</option>
        </select>
      </div>
      {rows.length === 0 ? <p className="te-empty">{t("te.tool.noMatch")}</p> : null}
      <ul className="te-scn-rows">
        {rows.slice(0, limit).map((s) => {
          const isOpen = open.has(s.id);
          const extra = Object.fromEntries(Object.entries(s.raw).filter(([k]) => !SHOWN_KEYS.has(k)));
          return (
            <li key={s.id} className={`te-scn-row is-${STATUS_TONE[s.status]}`}>
              <button type="button" className="te-scn-row__head" aria-expanded={isOpen} onClick={() => toggle(s.id)}>
                <Tag tone={STATUS_TONE[s.status]}>{s.rawStatus ?? s.status}</Tag>
                <span className="mono te-scn-row__id">{s.id}</span>
                <span className="te-scn-row__title">{s.title ?? <span className="te-faint">{t("te.tool.noTitle")}</span>}</span>
                {s.category ? <span className="te-token" title={categories[s.category]}>{s.category}</span> : null}
                <span className="mono te-scn-row__pts">{s.points != null ? `${fmtNum(s.points, 1)}${s.maxPoints != null ? `/${s.maxPoints}` : " pts"}` : ""}</span>
                <span className="te-faint te-scn-row__dur">{s.durationSeconds != null ? fmtDuration(s.durationSeconds, t) : ""}</span>
                <span className="te-scn-row__chev" aria-hidden>{isOpen ? "−" : "+"}</span>
              </button>
              {isOpen ? (
                <div className="te-scn-row__body">
                  {s.reasoning ? (
                    <div>
                      <span className="eyebrow">{t("te.tool.reasoning")}</span>
                      <pre className="te-pre">{s.reasoning}</pre>
                    </div>
                  ) : null}
                  {Object.keys(extra).length ? <GenericValue value={extra} /> : !s.reasoning ? <p className="te-faint">{t("te.tool.noDetails")}</p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {rows.length > limit ? (
        <button type="button" className="btn btn--sm" onClick={() => setLimit((l) => l + 150)}>
          {t("te.tool.showMore", { count: Math.min(150, rows.length - limit) })}
        </button>
      ) : null}
    </section>
  );
}
