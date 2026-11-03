import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SparkSnapshot } from "../../api/types";
import { benchTypeById } from "./benchCatalog";
import { SparkChips } from "./SparkChips";

interface BenchPageShellProps {
  type: string;
  spark: SparkSnapshot | null;
  sparks: readonly SparkSnapshot[];
  onSelectSpark: (id: string) => void;
  /** Extra controls on the right of the header. */
  tools?: ReactNode;
  /** Show the "Run on" Spark chips here. Pages that fold them into their own target row turn this off. */
  picker?: boolean;
  children: ReactNode;
}

/** Common header for every benchmark page: title and blurb, then a "Run on" Spark picker right under it. */
export function BenchPageShell({ type, spark, sparks, onSelectSpark, tools, picker = true, children }: BenchPageShellProps) {
  const { t } = useTranslation("bench");
  const bench = benchTypeById(type);
  return (
    <div className="bench-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">
            {bench?.family === "Tool Eval Bench"
              ? t("shell.eyebrowFamily", { family: t("shell.familyToolEval") })
              : bench
                ? t("shell.eyebrowFamily", { family: t("shell.familySparkDash") })
                : t("shell.eyebrow")}
          </div>
          <h1>{bench?.label ?? t("shell.titleFallback")}</h1>
          {bench ? <p className="page-head__sub">{bench.blurb}</p> : null}
        </div>
        <div className="page-head__tools">
          {tools}
        </div>
      </div>
      {picker ? (
        <div className="bench-runon">
          <span className="eyebrow">{t("runOn.label")}</span>
          {sparks.length === 0 ? <span className="bench-runon__none">{t("runOn.none")}</span> : null}
          <SparkChips sparks={sparks} activeId={spark?.id ?? null} onSelect={onSelectSpark} ariaLabel={t("runOn.chipsAria")} />
        </div>
      ) : null}
      {children}
    </div>
  );
}
