import { BenchIcon } from "../bench/BenchIcon";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AuthMode, SparkSnapshot } from "../../api/types";
import { isWorkerSpark } from "../../api/sparkRole";
import { ACTIVITY_ID, COST_ID, EINK_ID, ENERGY_ID, OVERVIEW_ID, SHOWCASE_ID, TEMPS_ID, TOKENS_ID, benchId, idToPath } from "../../constants";
import { BENCH_TYPES } from "../bench/benchCatalog";
import { BoltIcon, ChevronDownIcon, CoinsIcon, GearIcon, GithubIcon, GlobeIcon, GridIcon, ImageIcon, ListIcon, PanelLeftIcon, PlusIcon, SearchIcon, TerminalIcon, ThermometerIcon, TokensIcon, XLogoIcon } from "../ui/icons";
import { OpenAccessChip } from "../OpenAccessChip";
import { ThemeSwitch } from "../ThemeSwitch";
import { isThrottling, railSubLabel } from "./sparkSummary";

interface AppSidebarProps {
  sparks: SparkSnapshot[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onReorder?: (orderedIds: string[]) => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  /** Benchmark type whose page is showing, if any. */
  benchType?: string | null;
  onSelectBench?: (type: string) => void;
  connected: boolean;
  /** Poll interval in ms for the footer caption. */
  refreshInterval?: number | null;
  /** Server auth posture; an open remote bind shows a gentle note above the credit line. */
  authMode?: AuthMode | null;
  /** Hide the sidebar (a strip with a show button stays behind). */
  onCollapse?: () => void;
}

/**
 * Keyboard drag on the rail: M picks a Spark up. The default Enter/Space start would swallow the
 * very keys that activate the Spark's button, so keyboard users could not open a Spark at all.
 * Once lifted, arrows move it and Enter/Space drop it, Escape cancels.
 */
export const RAIL_KEYBOARD_CODES = {
  start: ["KeyM"],
  cancel: ["Escape"],
  end: ["Space", "Enter"],
};

function dotClass(spark: SparkSnapshot): string {
  if (!spark.online) return "sdot sdot--off";
  if (isThrottling(spark)) return "sdot sdot--warn";
  return "sdot";
}

/** The rail's status words, translated once by the caller so the pure label logic stays pure. */
export interface RailStatusLabels {
  off: string;
  worker: string;
  prefilling: string;
  decoding: string;
}

/**
 * Strata exposes explicit activity flags when it has no current decode window.
 * A zero decode rate during either state is not an idle throughput reading, so
 * keep the rail from presenting it as a measured 0.0 tok/s.
 */
export function sidebarSubLabel(spark: SparkSnapshot, labels: RailStatusLabels): string {
  if (!spark.online) return labels.off;
  if (isWorkerSpark(spark)) return labels.worker;
  const llm = Array.isArray(spark.metrics.llm) ? spark.metrics.llm.find((entry) => entry.available) : null;
  if (llm?.backend === "strata" && !(Number.isFinite(llm.generationTps) && llm.generationTps > 0)) {
    if (llm.prefillActive) return labels.prefilling;
    if (llm.decodeActive) return labels.decoding;
  }
  const label = railSubLabel(spark);
  return label === "off" ? labels.off : label === "worker" ? labels.worker : label;
}

/**
 * A drag ends on pointer-up over the very link that was lifted, and the browser then fires a click on
 * it. dnd-kit stops that click at the document (capture phase), so React's onClick never sees it and
 * the browser follows the link's href on its own. A window-level capture listener runs before dnd-kit's
 * and cancels the default action for a moment after a drop.
 */
const DROP_CLICK_GUARD_MS = 400;
let lastDropAt = 0;
let removeDropGuard: (() => void) | null = null;
export function markRailDrop(now: number = Date.now()) {
  lastDropAt = now;
  removeDropGuard?.();
  if (typeof window === "undefined") return;
  const onClick = (e: Event) => {
    e.preventDefault();
  };
  window.addEventListener("click", onClick, true);
  const timer = window.setTimeout(() => removeDropGuard?.(), DROP_CLICK_GUARD_MS);
  removeDropGuard = () => {
    window.removeEventListener("click", onClick, true);
    window.clearTimeout(timer);
    removeDropGuard = null;
  };
}
export function clickFollowsRailDrop(now: number = Date.now()): boolean {
  return now - lastDropAt < DROP_CLICK_GUARD_MS;
}

/** Plain left-click navigates in-app; modified clicks and the context menu keep normal link behaviour. */
function inApp(go: () => void) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (clickFollowsRailDrop()) {
      e.preventDefault();
      return;
    }
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go();
  };
}

function RailSpark({
  spark,
  isActive,
  onSelect,
  labels,
}: {
  spark: SparkSnapshot;
  isActive: boolean;
  onSelect: (id: string) => void;
  labels: RailStatusLabels;
}) {
  const { t } = useTranslation("common");
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: spark.id });
  const dragTitle = spark.online
    ? t("dragTitle", { name: spark.name })
    : t("dragTitleOffline", { name: spark.name });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined, opacity: isDragging ? 0.6 : 1 }}
      className={`rail-item ${isActive ? "is-active" : ""}`}
    >
      <a
        href={idToPath(spark.id)}
        draggable={false}
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        className="flex min-w-0 flex-1 items-center gap-2.5 border-0 bg-transparent p-0 text-left text-inherit no-underline"
        onClick={inApp(() => onSelect(spark.id))}
        aria-current={isActive ? "page" : undefined}
        aria-roledescription={t("sortable")}
        title={dragTitle}
      >
        <i className={dotClass(spark)} aria-hidden />
        <span className="rail-item__name">{spark.name}</span>
      </a>
      <span className="rail-item__sub">{sidebarSubLabel(spark, labels)}</span>
    </div>
  );
}

/** Left fleet rail: brand, workspace links, reorderable Spark list, settings and live-link status. */
export function AppSidebar({
  sparks,
  activeId,
  onSelect,
  onAdd,
  onReorder,
  onOpenSettings,
  onOpenSearch,
  benchType = null,
  onSelectBench,
  connected,
  refreshInterval,
  authMode = null,
  onCollapse,
}: AppSidebarProps) {
  const { t: tn } = useTranslation("nav");
  const { t: tc } = useTranslation("common");
  const [items, setItems] = useState<string[]>(() => sparks.map((s) => s.id));
  const [dragging, setDragging] = useState(false);
  const [benchOpen, setBenchOpen] = useState(() => {
    try {
      return localStorage.getItem("sparkdash.sidebar.benchOpen") !== "0";
    } catch {
      return true;
    }
  });
  const statusLabels: RailStatusLabels = {
    off: tc("status.off"),
    worker: tc("status.worker"),
    prefilling: tc("status.prefilling"),
    decoding: tc("status.decoding"),
  };
  const toggleBench = () =>
    setBenchOpen((open) => {
      try {
        localStorage.setItem("sparkdash.sidebar.benchOpen", open ? "0" : "1");
      } catch {
        /* private mode */
      }
      return !open;
    });

  useEffect(() => {
    if (dragging) return;
    setItems(sparks.map((s) => s.id));
  }, [sparks, dragging]);

  const byId = useMemo(() => new Map(sparks.map((s) => [s.id, s])), [sparks]);
  const ordered = items.map((id) => byId.get(id)).filter(Boolean) as SparkSnapshot[];
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: RAIL_KEYBOARD_CODES })
  );
  const canReorder = Boolean(onReorder) && sparks.length > 1;
  const liveCaption = connected
    ? refreshInterval
      ? tc("livePoll", { seconds: Math.round(refreshInterval / 100) / 10 })
      : tc("live")
    : tc("reconnecting");

  const handleDragEnd = (event: DragEndEvent) => {
    markRailDrop();
    setDragging(false);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = items.indexOf(String(active.id));
    const to = items.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(items, from, to);
    setItems(next);
    onReorder?.(next);
  };

  return (
    <aside className="app-side" aria-label={tc("fleetNavigation")}>
      <div className="side-head">
        <a
          href={idToPath(OVERVIEW_ID)}
          className="brand"
          aria-label={tc("brand")}
          onClick={(e) => {
            // Plain click navigates in-app; modifier clicks and the context menu keep the normal link behaviour.
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            onSelect(OVERVIEW_ID);
          }}
        >
          <span className="brand__mark">
            <BoltIcon className="h-[17px] w-[17px]" />
          </span>
          <span>
            spark<span className="brand__dash">Dash</span>
          </span>
        </a>
        {onCollapse ? (
          <button type="button" className="icon-circle side-toggle" onClick={onCollapse} title={tc("hideSidebarShortcut")} aria-label={tc("hideSidebar")}>
            <PanelLeftIcon className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <div className="side-tools">
        <button type="button" className="search-trigger" onClick={onOpenSearch} aria-label={tc("openCommandPalette")}>
          <SearchIcon className="h-4 w-4 shrink-0" />
          <span>{tn("jumpTo")}</span>
          <span className="kbd">Ctrl K</span>
        </button>
      </div>

      <div className="min-h-0">
        <div className="rail-label">
          <span>{tn("sparks")}</span>
          <button type="button" onClick={onAdd} title={tc("addSparkHost")} aria-label={tc("addSparkHost")}>
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        {canReorder ? (
          <DndContext
            sensors={sensors}
            accessibility={{ screenReaderInstructions: { draggable: tc("dragInstructions") } }}
            collisionDetection={closestCenter}
            onDragStart={() => setDragging(true)}
            onDragEnd={handleDragEnd}
            onDragCancel={() => {
              markRailDrop();
              setDragging(false);
            }}
          >
            <SortableContext items={items} strategy={verticalListSortingStrategy}>
              <nav className="rail-list" aria-label={tn("sparks")}>
                {ordered.map((s) => (
                  <RailSpark key={s.id} spark={s} isActive={activeId === s.id} onSelect={onSelect} labels={statusLabels} />
                ))}
              </nav>
            </SortableContext>
          </DndContext>
        ) : (
          <nav className="rail-list" aria-label={tn("sparks")}>
            {sparks.map((s) => (
              <div key={s.id} className={`rail-item ${activeId === s.id ? "is-active" : ""}`}>
                <a
                  href={idToPath(s.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 border-0 bg-transparent p-0 text-left text-inherit no-underline"
                  onClick={inApp(() => onSelect(s.id))}
                  aria-current={activeId === s.id ? "page" : undefined}
                >
                  <i className={dotClass(s)} aria-hidden />
                  <span className="rail-item__name">{s.name}</span>
                </a>
                <span className="rail-item__sub">{sidebarSubLabel(s, statusLabels)}</span>
              </div>
            ))}
          </nav>
        )}
        {sparks.length === 0 ? (
          <p className="px-2.5 pt-1 text-xs text-muted">{tn("noSparksYet")}</p>
        ) : null}
      </div>

      <div>
        <div className="rail-label">{tn("workspace")}</div>
        <nav className="rail-list">
          <a
            href={idToPath(OVERVIEW_ID)}
            className={`rail-item ${activeId === OVERVIEW_ID ? "is-active" : ""}`}
            onClick={inApp(() => onSelect(OVERVIEW_ID))}
            aria-current={activeId === OVERVIEW_ID ? "page" : undefined}
          >
            <GridIcon className="h-4 w-4" />
            <span className="rail-item__name">{tn("overview")}</span>
          </a>
          <a
            href={idToPath(TOKENS_ID)}
            className={`rail-item ${activeId === TOKENS_ID ? "is-active" : ""}`}
            onClick={inApp(() => onSelect(TOKENS_ID))}
            aria-current={activeId === TOKENS_ID ? "page" : undefined}
          >
            <TokensIcon className="h-4 w-4" />
            <span className="rail-item__name">{tn("tokenTotals")}</span>
          </a>
          <a
            href={idToPath(COST_ID)}
            className={`rail-item ${activeId === COST_ID ? "is-active" : ""}`}
            onClick={inApp(() => onSelect(COST_ID))}
            aria-current={activeId === COST_ID ? "page" : undefined}
          >
            <CoinsIcon className="h-4 w-4" />
            <span className="rail-item__name">{tn("costCompare")}</span>
          </a>
          <a
            href={idToPath(EINK_ID)}
            className={`rail-item ${activeId === EINK_ID ? "is-active" : ""}`}
            onClick={inApp(() => onSelect(EINK_ID))}
            aria-current={activeId === EINK_ID ? "page" : undefined}
          >
            <ImageIcon className="h-4 w-4" />
            <span className="rail-item__name">{tn("ePaper")}</span>
          </a>
          <a
            href={idToPath(ENERGY_ID)}
            className={`rail-item ${activeId === ENERGY_ID ? "is-active" : ""}`}
            onClick={inApp(() => onSelect(ENERGY_ID))}
            aria-current={activeId === ENERGY_ID ? "page" : undefined}
          >
            <BoltIcon className="h-4 w-4" />
            <span className="rail-item__name">{tn("fleetEnergy")}</span>
          </a>
          <a
            href={idToPath(TEMPS_ID)}
            className={`rail-item ${activeId === TEMPS_ID ? "is-active" : ""}`}
            onClick={inApp(() => onSelect(TEMPS_ID))}
            aria-current={activeId === TEMPS_ID ? "page" : undefined}
          >
            <ThermometerIcon className="h-4 w-4" />
            <span className="rail-item__name">{tn("temps")}</span>
          </a>
          <a
            href={idToPath(ACTIVITY_ID)}
            className={`rail-item ${activeId === ACTIVITY_ID ? "is-active" : ""}`}
            onClick={inApp(() => onSelect(ACTIVITY_ID))}
            aria-current={activeId === ACTIVITY_ID ? "page" : undefined}
          >
            <ListIcon className="h-4 w-4" />
            <span className="rail-item__name">{tn("activity")}</span>
          </a>
          <a
            href={idToPath(SHOWCASE_ID)}
            className={`rail-item ${activeId === SHOWCASE_ID ? "is-active" : ""}`}
            onClick={inApp(() => onSelect(SHOWCASE_ID))}
            aria-current={activeId === SHOWCASE_ID ? "page" : undefined}
          >
            <TerminalIcon className="h-4 w-4" />
            <span className="rail-item__name">{tn("showcase")}</span>
          </a>
        </nav>
      </div>

      {onSelectBench ? (
        <div>
          <button
            type="button"
            className="rail-label rail-label--toggle"
            onClick={toggleBench}
            aria-expanded={benchOpen || benchType != null}
            aria-controls="rail-benchmarks"
          >
            <span>{tn("benchmarks")}</span>
            <ChevronDownIcon className={`h-3 w-3 transition-transform ${benchOpen || benchType != null ? "" : "-rotate-90"}`} />
          </button>
          <nav className="rail-list" id="rail-benchmarks" aria-label={tn("benchmarks")} hidden={!(benchOpen || benchType != null)}>
            {BENCH_TYPES.map((b) => (
              <div key={b.id}>
                <a
                  href={idToPath(benchId(b.id))}
                  className={`rail-item rail-item--compact ${benchType === b.id ? "is-active" : ""}`}
                  onClick={inApp(() => onSelectBench(b.id))}
                  aria-current={benchType === b.id ? "page" : undefined}
                  title={b.blurb}
                >
                  <BenchIcon id={b.id} className="h-3.5 w-3.5" />
                  <span className="rail-item__name">{b.label}</span>
                </a>
              </div>
            ))}
          </nav>
        </div>
      ) : null}

      <div className="rail-foot">
        <div className="rail-settings">
          <nav className="rail-list">
            <button type="button" className="rail-item" onClick={onOpenSettings}>
              <GearIcon className="h-4 w-4" />
              <span className="rail-item__name">{tn("settings")}</span>
            </button>
          </nav>
          <ThemeSwitch />
        </div>
        <div className="rail-conn" role="status">
          <i className={`sdot ${connected ? "" : "sdot--warn"}`} aria-hidden />
          <span>{liveCaption}</span>
        </div>
        <OpenAccessChip authMode={authMode} />
        <div className="rail-credit">
          <span>{tc("credit")}</span>
          <span className="rail-credit__links">
            <a href="https://mia-ai.net/" target="_blank" rel="noopener noreferrer" title={tc("creditWebsite")} aria-label={tc("creditWebsite")}>
              <GlobeIcon className="h-3.5 w-3.5" />
            </a>
            <a href="https://github.com/MiaAI-Lab/sparkDash" target="_blank" rel="noopener noreferrer" title={tc("creditGithub")} aria-label={tc("creditGithub")}>
              <GithubIcon className="h-3.5 w-3.5" />
            </a>
            <a href="https://x.com/MiaAI_lab" target="_blank" rel="noopener noreferrer" title={tc("creditX")} aria-label={tc("creditX")}>
              <XLogoIcon className="h-3 w-3" />
            </a>
          </span>
        </div>
      </div>
    </aside>
  );
}