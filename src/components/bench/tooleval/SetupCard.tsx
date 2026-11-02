import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchToolEvalInstallCommand, fetchToolEvalUpdateCheck } from "../../../api/client";
import type { SparkSnapshot, ToolEvalSpec, ToolEvalStatus, ToolEvalUpdateCheck } from "../../../api/types";
import { fmtDate } from "./format";
import { Tag } from "../../ui/Tag";
import { CopyButton, Notice, RunTerminal, Skeleton, linesText } from "./parts";
import { useToolEvalInstall } from "./hooks";

interface SetupProps {
  spark: SparkSnapshot;
  spec: ToolEvalSpec | null;
  status: ToolEvalStatus | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  /** Another job holds the Spark; installs would be refused. */
  busy: boolean;
}

const NO_EXTRAS: string[] = [];

/** Install / upgrade of tool-eval-bench on the Spark, and the installed-state status line. */
export function SetupCard({ spark, spec, status, loading, error, reload, busy }: SetupProps) {
  const { t } = useTranslation("bench");
  const install = useToolEvalInstall(spark.id, reload);
  // The optional pip extras (perf, hf) are not offered: the plain install is all sparkDash needs.
  const extras: string[] = NO_EXTRAS;
  const [forceReinstall, setForceReinstall] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<{ loading: boolean; data: ToolEvalUpdateCheck | null; error: string | null }>({ loading: false, data: null, error: null });
  // Opens the upgrade step: the command, the force-reinstall option and the confirmation.
  const openUpgrade = () => {
    setOpen(true);
    setConfirm(true);
  };
  const runCheck = () => {
    setCheck({ loading: true, data: null, error: null });
    fetchToolEvalUpdateCheck(spark.id)
      .then((data) => setCheck({ loading: false, data, error: null }))
      .catch((e) => setCheck({ loading: false, data: null, error: e instanceof Error ? e.message : String(e) }));
  };
  const installed = Boolean(status?.installed);
  // A finished install collapses back to the compact status line (its output was just on screen);
  // a running or failed one stays open so the output and the retry are in reach.
  const justInstalled = installed && install.job?.status === "completed";
  const showInstaller = !installed || open || install.running || (install.job != null && !justInstalled);

  // A finished install closes the upgrade panel, shows the success line, and re-checks the version.
  const settledJob = useRef<string | null>(null);
  const versionBefore = useRef<string | null>(null);
  const [done, setDone] = useState<{ from: string | null; kind: "upgrade" | "install" } | null>(null);
  const jobId = install.job?.id ?? null;
  const jobDone = install.job?.status === "completed";
  useEffect(() => {
    if (!jobDone || !jobId || settledJob.current === jobId) return;
    settledJob.current = jobId;
    setDone({ from: versionBefore.current, kind: versionBefore.current ? "upgrade" : "install" });
    setOpen(false);
    setConfirm(false);
    setForceReinstall(false);
    runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobDone, jobId]);

  useEffect(() => {
    if (!showInstaller) return;
    let off = false;
    fetchToolEvalInstallCommand(spark.id, extras, installed && !forceReinstall)
      .then((r) => !off && setCommand(r.command))
      .catch(() => !off && setCommand(null));
    return () => {
      off = true;
    };
  }, [spark.id, extras, forceReinstall, installed, showInstaller]);

  if (!status && loading) return <Skeleton lines={2} className="te-card te-card--pad" />;
  if (!status) {
    return (
      <Notice tone="bad" title={t("te.setup.checkFailedTitle")} actions={<button type="button" className="btn btn--sm" onClick={reload}>{t("te.setup.retry")}</button>}>
        {error ?? t("te.setup.noAnswer")}
      </Notice>
    );
  }
  const uvMissing = !status.uv;
  const failedText = install.lines.map((l) => l.text).join("\n");
  const uvProblem = install.job?.status === "failed" && /uv: (command )?not found|uv is not installed|No such file/i.test(failedText);

  const installer = (
    <div className="te-installer">
      <div className="te-cmd">
        <div className="te-cmd__head">
          <span className="eyebrow">{t("te.setup.commandOn", { name: spark.name })}</span>
          {command ? <CopyButton text={command} /> : null}
        </div>
        <pre className="te-cmd__body">{command ?? "…"}</pre>
      </div>
      <p className="te-note">
        {installed && !forceReinstall ? t("te.setup.upgradeNote", { name: spark.name }) : t("te.setup.installNote", { name: spark.name })}{" "}
        {t("te.setup.needsInternet")}
      </p>
      {uvMissing ? (
        <Notice tone="warn" title={t("te.setup.uvMissingTitle")}>{t("te.setup.uvMissingBody")}</Notice>
      ) : null}
      {install.job ? (
        <div className="te-install-out">
          <div className="te-install-out__head">
            <Tag tone={install.job.status === "running" ? "acc" : install.job.status === "completed" ? "good" : "bad"}>
              {install.job.status === "running" ? t("te.setup.installing") : install.job.status === "completed" ? t("te.setup.installed") : t("te.setup.installFailed")}
            </Tag>
            <CopyButton text={() => linesText(install.lines, install.partial)} label={t("te.setup.copyOutput")} />
          </div>
          <RunTerminal lines={install.lines} partial={install.partial} running={install.running} />
          {install.job.status === "completed" ? <p className="te-ok" role="status">{t("te.setup.doneChecking")}</p> : null}
          {install.job.status === "failed" ? (
            <Notice tone="bad" title={t("te.setup.installDidNotFinish")}>
              {uvProblem ? t("te.setup.uvNotFound") : install.job.error ?? t("te.setup.installFailedHint")}
            </Notice>
          ) : null}
        </div>
      ) : null}
      {install.error ? <Notice tone="bad">{install.error}</Notice> : null}
      <div className="te-actions">
        {!confirm ? (
          <button type="button" className="btn btn--primary" disabled={install.running || busy} onClick={() => setConfirm(true)}>
            {installed ? t("te.setup.upgradeNow") : t("te.setup.installOn", { name: spark.name })}
          </button>
        ) : (
          <>
            <span className="te-confirm-text">{t("te.setup.confirmRun", { name: spark.name })}</span>
            <button
              type="button"
              className="btn btn--primary"
              disabled={install.running}
              onClick={() => {
                setConfirm(false);
                versionBefore.current = status?.installed ? status.version : null;
                setDone(null);
                void install.start(extras, installed && !forceReinstall);
              }}
            >
              {installed ? t("te.setup.yesUpgrade") : t("te.setup.yesInstall")}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setConfirm(false);
                if (installed) {
                  setOpen(false);
                  setForceReinstall(false);
                }
              }}
            >
              {t("te.setup.cancel")}
            </button>
          </>
        )}
        {busy ? <span className="te-faint">{t("te.setup.jobRunning")}</span> : null}
        {installed ? (
          <label className="te-check te-check--inline">
            <input type="checkbox" checked={forceReinstall} onChange={(e) => setForceReinstall(e.target.checked)} disabled={install.running} />
            <span>{t("te.setup.forceReinstall")}</span>
          </label>
        ) : null}
        {installed ? null : (
          <button type="button" className="btn btn--ghost" onClick={reload} disabled={loading}>
            {loading ? t("te.setup.checking") : t("te.setup.checkAgain")}
          </button>
        )}
      </div>
    </div>
  );

  if (!installed) {
    return (
      <section className="panel te-card te-card--setup" aria-labelledby="te-setup-title">
        <div className="te-card__head">
          <div>
            <div className="eyebrow">{t("te.setup.setup")}</div>
            <h2 id="te-setup-title">{t("te.setup.notInstalledTitle", { name: spark.name })}</h2>
          </div>
          <Tag tone="warn">{t("te.setup.notInstalledTag")}</Tag>
        </div>
        <p className="te-lead">{t("te.setup.lead")}</p>
        {status.error && !status.reachable ? <Notice tone="bad" title={t("te.setup.unreachable")}>{status.error}</Notice> : null}
        {installer}
      </section>
    );
  }

  return (
    <section className="panel te-card te-status" aria-label={t("te.setup.statusAria")}>
      <div className="te-status__line">
        <Tag tone="good">{t("te.setup.installed")}</Tag>
        <span>
          tool-eval-bench <b className="mono">{status.version?.replace(/^tool-eval-bench\s+/i, "") ?? t("te.setup.unknownVersion")}</b>
        </span>
        <span className="te-faint mono" title={status.path ?? ""}>{status.path}</span>
        {status.pythonVersion ? <span className="te-faint">{status.pythonVersion}</span> : null}
        <span className="te-status__spacer" />
        <button type="button" className="btn btn--sm" onClick={runCheck} disabled={check.loading}>
          {check.loading ? t("te.setup.checkingGithub") : t("te.setup.checkUpdates")}
        </button>
      </div>
      {check.error ? <Notice tone="bad" title={t("te.setup.updateCheckFailed")}>{check.error}</Notice> : null}
      {check.data ? (
        check.data.upToDate === true ? (
          <p className="te-ok" role="status">
            {t("te.setup.latest")}{" "}
            <span className="te-faint">
              {t("te.setup.installedCommit", { commit: check.data.installedCommit ?? "" })}
              {check.data.latestDate ? ` · ${t("te.setup.latestChange", { date: fmtDate(Date.parse(check.data.latestDate)) })}` : ""}
            </span>{" "}
            <button type="button" className="te-link" onClick={() => { setForceReinstall(true); openUpgrade(); }}>
              {t("te.setup.reinstall")}
            </button>
          </p>
        ) : check.data.upToDate === false ? (
          <Notice
            tone="info"
            title={t("te.setup.newerAvailable")}
            actions={
              <button type="button" className="btn btn--sm btn--primary" onClick={openUpgrade}>
                {t("te.setup.upgradeNow")}
              </button>
            }
          >
            {t("te.setup.latestCommit", { commit: check.data.latestCommit?.slice(0, 9) ?? "" })}
            {check.data.latestDate ? ` (${fmtDate(Date.parse(check.data.latestDate))})` : ""}
            {t("te.setup.installedIs", { commit: check.data.installedCommit ?? "" })}
            {t("te.setup.upgradeRunsOn", { name: spark.name })}
          </Notice>
        ) : (
          <Notice
            tone="warn"
            title={t("te.setup.updateUnknown")}
            actions={
              <button type="button" className="btn btn--sm" onClick={openUpgrade}>
                {t("te.setup.upgradeAnyway")}
              </button>
            }
          >
            {check.data.error ?? t("te.setup.noCommit")}
            {t("te.setup.stillUpgrade")}
          </Notice>
        )
      ) : null}
      {status.workDir ? (
        <p className="te-note">{t("te.setup.workDir", { path: status.workDir, name: spark.name })}</p>
      ) : null}
      {done && !showInstaller ? (
        <Notice
          tone="good"
          title={done.kind === "upgrade" ? t("te.setup.upgradeComplete") : t("te.setup.installationComplete")}
          actions={
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDone(null)}>
              {t("te.setup.dismiss")}
            </button>
          }
        >
          {done.kind === "upgrade" && done.from && done.from !== status.version
            ? t("te.setup.upgradedFrom", {
                name: spark.name,
                from: done.from.replace(/^tool-eval-bench\s+/i, ""),
                to: status.version?.replace(/^tool-eval-bench\s+/i, "") ?? "",
              })
            : done.kind === "upgrade"
              ? t("te.setup.reinstalled", { name: spark.name, version: status.version?.replace(/^tool-eval-bench\s+/i, "") ?? "" })
              : t("te.setup.installedNow", { name: spark.name, version: status.version?.replace(/^tool-eval-bench\s+/i, "") ?? "" })}
        </Notice>
      ) : null}
      {showInstaller ? installer : null}
    </section>
  );
}
