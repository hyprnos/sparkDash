import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { fetchGpuClock, fetchGpuClockCommand, resetGpuClock, setGpuClock } from "../api/client";
import type { GpuClockStatus } from "../api/types";

const MIN_CAP_MHZ = 300;

type Ready = Extract<GpuClockStatus, { supported: true }>;

/** Highest clock a boot hook applies, e.g. "0,2200" -> 2200. */
function bootMax(status: Ready): number | null {
  const m = /^\d+,(\d+)$/.exec(status.service.clocks ?? status.cron.clocks ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * GPU clock cap for one Spark (Edit unit). Acts immediately on the unit with the
 * saved connection settings: it is not part of the Save button.
 */
export function GpuClockSection({ sparkId }: { sparkId: string }) {
  const { t } = useTranslation("ui");
  const { t: tc } = useTranslation("common");
  const [status, setStatus] = useState<GpuClockStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [maxInput, setMaxInput] = useState("");
  const [persist, setPersist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  /** Command for running the change by hand on the unit (plain sudo, asks for the password). */
  const [manual, setManual] = useState<{ title: string; command: string } | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Typed sudo password: kept in this component's state only, sent with one request, then cleared. */
  const [sudoPw, setSudoPw] = useState("");
  /** Only the newest request may write state: a slow answer for an older unit must not win. */
  const latest = useRef(0);
  const sparkRef = useRef(sparkId);
  sparkRef.current = sparkId;

  const syncInputs = (s: GpuClockStatus) => {
    if (!s.supported) return;
    const cap = s.capMHz ?? bootMax(s);
    setMaxInput(cap != null ? String(cap) : "");
    setPersist(s.service.installed || s.cron.installed);
  };

  const load = useCallback(
    async (opts: { sync: boolean }) => {
      const mine = ++latest.current;
      try {
        const s = await fetchGpuClock(sparkId);
        if (mine !== latest.current) return;
        setStatus(s);
        setLoadError(null);
        if (opts.sync) syncInputs(s);
      } catch (err) {
        if (mine !== latest.current) return;
        // Keep what is on screen after a failed refresh; the message says what went wrong.
        setLoadError(err instanceof Error ? err.message : t("gpuClock.readFailed"));
      }
    },
    [sparkId, t]
  );

  useEffect(() => {
    setStatus(null);
    setLoadError(null);
    setMessage(null);
    setMaxInput("");
    setPersist(false);
    setManual(null);
    setManualError(null);
    setSudoPw("");
    setBusy(false);
    void load({ sync: true });
    return () => {
      latest.current += 1;
    };
  }, [load]);

  if (!status) {
    return (
      <div className="gpu-clock">
        <span className="field-label">{t("gpuClock.cap")}</span>
        <p className={`field-hint${loadError ? " is-warn" : ""}`} role="status">
          {loadError ?? t("gpuClock.reading")}
        </p>
      </div>
    );
  }
  if (!status.supported) {
    return (
      <div className="gpu-clock">
        <span className="field-label">{t("gpuClock.cap")}</span>
        <p className="field-hint">{status.reason || t("gpuClock.unsupported")}</p>
      </div>
    );
  }

  const hwMax = status.hwMaxMHz;
  const maxMHz = Number(maxInput);
  const valid =
    maxInput.trim() !== "" &&
    Number.isInteger(maxMHz) &&
    maxMHz >= MIN_CAP_MHZ &&
    (hwMax == null || maxMHz <= hwMax);
  const sudoMissing = status.sudo === "no";
  /** A password typed here crosses the network: only over https or from the machine itself. */
  const secure =
    (typeof window === "undefined" || window.isSecureContext !== false) && status.passwordAllowed !== false;
  const needPw = sudoMissing && secure;
  const pwOk = !needPw || sudoPw.length > 0;
  const pwArg = needPw ? sudoPw : undefined;
  /**
   * No boot hook is reachable here at all: the checkbox says so instead of refusing on Apply.
   * Without passwordless sudo the status cannot probe for one, so a typed password decides it on the unit.
   */
  const cannotPersist = !sudoMissing && status.persistKind === "none";

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await action() });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : t("gpuClock.refused") });
    } finally {
      // A slow answer for the unit you just left must not wipe what you type for this one.
      if (sparkRef.current === sparkId) {
        setBusy(false);
        setSudoPw("");
        await load({ sync: true });
      }
    }
  };

  const apply = () => {
    const how = status.persistKind === "cron" ? t("gpuClock.byCronJob") : t("gpuClock.byService");
    if (persist && !confirm(t("gpuClock.confirmKeep", { how }))) return;
    void run(async () => {
      const out = await setGpuClock(sparkId, { maxMHz, persist, ...(pwArg ? { sudoPassword: pwArg } : {}) });
      if (!persist) return t("gpuClock.cappedUntilReboot", { mhz: maxMHz });
      return out.persistKind === "cron"
        ? t("gpuClock.cappedKeptCron", { mhz: maxMHz })
        : t("gpuClock.cappedKeptService", { mhz: maxMHz });
    });
  };

  const remove = () => {
    if (!confirm(t("gpuClock.removeConfirm"))) return;
    void run(async () => {
      await resetGpuClock(sparkId, pwArg);
      return t("gpuClock.capRemoved");
    });
  };

  const showCommand = async (kind: "apply" | "reset") => {
    setManualError(null);
    setCopied(false);
    try {
      const q = kind === "apply" ? ({ action: "apply", maxMHz, persist } as const) : ({ action: "reset" } as const);
      const { command } = await fetchGpuClockCommand(sparkId, q);
      setManual({
        title:
          kind === "apply"
            ? persist
              ? t("gpuClock.commandApplyTitlePersist", { mhz: maxMHz })
              : t("gpuClock.commandApplyTitle", { mhz: maxMHz })
            : t("gpuClock.commandResetTitle"),
        command,
      });
    } catch (err) {
      setManual(null);
      setManualError(err instanceof Error ? err.message : t("gpuClock.commandFailed"));
    }
  };

  const copyCommand = async () => {
    if (!manual) return;
    try {
      await navigator.clipboard.writeText(manual.command);
      setCopied(true);
    } catch {
      // Plain-http dashboards have no clipboard API: the text box below is selectable.
      setCopied(false);
    }
  };

  const bootState =
    status.service.enabled === "enabled" ? t("gpuClock.bootServiceEnabled") : status.service.enabled || t("gpuClock.bootServiceInstalled");

  return (
    <div className="gpu-clock">
      <label className="field-label" htmlFor="gpu-clock-max">
        {t("gpuClock.cap")}
      </label>
      <p className="gpu-clock__now" data-testid="gpu-clock-now">
        {status.capMHz != null ? (
          <>
            <Trans i18nKey="gpuClock.cappedAt" ns="ui" values={{ mhz: status.capMHz }} components={{ b: <b /> }} />
            {hwMax != null ? t("gpuClock.gpuMaximum", { mhz: hwMax }) : ""}
          </>
        ) : (
          <>{t("gpuClock.noCap")}{hwMax != null ? t("gpuClock.gpuMaximum", { mhz: hwMax }) : ""}</>
        )}
        {status.service.installed
          ? `${t("gpuClock.bootService", { state: bootState })}${status.service.clocks ? t("gpuClock.bootClocks", { clocks: status.service.clocks }) : ""}`
          : status.cron.installed
            ? `${t("gpuClock.rebootJob")}${status.cron.clocks ? t("gpuClock.bootClocks", { clocks: status.cron.clocks }) : ""}`
            : t("gpuClock.notKept")}
      </p>
      {status.cron.installed && status.cron.failed ? (
        <p className="field-hint is-warn" role="alert" data-testid="gpu-clock-boot-failed">
          <Trans i18nKey="gpuClock.bootFailed" ns="ui" components={{ code: <code /> }} />
        </p>
      ) : null}
      <div className="gpu-clock__row">
        <input
          id="gpu-clock-max"
          type="number"
          min={MIN_CAP_MHZ}
          max={hwMax ?? undefined}
          inputMode="numeric"
          placeholder={hwMax != null ? `${MIN_CAP_MHZ}–${hwMax}` : "MHz"}
          value={maxInput}
          onChange={(e) => setMaxInput(e.target.value)}
          disabled={busy}
        />
        <span className="gpu-clock__unit">{t("gpuClock.mhzMax")}</span>
        <button type="button" className="btn btn--sm" onClick={apply} disabled={busy || !valid || !pwOk || (sudoMissing && !secure)}>
          {busy ? tc("state.working") : tc("actions.apply")}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={remove} disabled={busy || !pwOk || (sudoMissing && !secure)}>
          {t("gpuClock.removeLimit")}
        </button>
      </div>
      <label className="gpu-clock__check">
        <input
          type="checkbox"
          checked={persist}
          onChange={(e) => setPersist(e.target.checked)}
          disabled={busy || (cannotPersist && !persist)}
        />
        {t("gpuClock.keepAfterReboot", {
          how: cannotPersist
            ? t("gpuClock.notAvailableHere")
            : status.persistKind === "cron"
              ? t("gpuClock.byCronJob")
              : t("gpuClock.byService"),
        })}
      </label>
      {needPw && (
        <div>
          <label className="field-label" htmlFor="gpu-clock-sudo-pw">
            {t("gpuClock.sudoPassword")}
          </label>
          <input
            id="gpu-clock-sudo-pw"
            type="password"
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            value={sudoPw}
            onChange={(e) => setSudoPw(e.target.value)}
            disabled={busy}
            placeholder={t("gpuClock.sudoPasswordPlaceholder")}
          />
          <p className="field-hint">{t("gpuClock.sudoPasswordHelp")}</p>
        </div>
      )}
      {sudoMissing && !secure && (
        <p className="field-hint is-warn">
          <Trans i18nKey="gpuClock.insecureHelp" ns="ui" components={{ code: <code /> }} />
        </p>
      )}
      {!sudoMissing && (
        <p className="field-hint">
          <Trans
            i18nKey={status.sudo === "root" ? "gpuClock.runsCommandRoot" : "gpuClock.runsCommand"}
            ns="ui"
            components={{ code: <code /> }}
          />
        </p>
      )}
      {cannotPersist ? (
        <p className="field-hint is-warn">{t("gpuClock.cannotPersist")}</p>
      ) : null}
      {maxInput.trim() !== "" && !valid && (
        <p className="field-hint is-warn">
          {hwMax != null
            ? t("gpuClock.invalidRangeMax", { min: MIN_CAP_MHZ, max: hwMax })
            : t("gpuClock.invalidRange", { min: MIN_CAP_MHZ })}
        </p>
      )}
      <details className="gpu-clock__manual" open={(sudoMissing && !secure) || manual != null}>
        <summary>{t("gpuClock.manualSummary")}</summary>
        <p className="field-hint">
          <Trans i18nKey="gpuClock.manualHelp" ns="ui" components={{ code: <code /> }} />
        </p>
        <div className="gpu-clock__row">
          <button type="button" className="btn btn--sm" onClick={() => void showCommand("apply")} disabled={!valid}>
            {t("gpuClock.showApplyCommand")}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void showCommand("reset")}>
            {t("gpuClock.showRemoveCommand")}
          </button>
        </div>
        {manualError && <p className="field-hint is-warn" role="status">{manualError}</p>}
        {manual && (
          <>
            <p className="gpu-clock__now">{manual.title}</p>
            <textarea className="gpu-clock__command" readOnly rows={8} value={manual.command} aria-label={t("gpuClock.commandAria")} onFocus={(e) => e.currentTarget.select()} />
            <div className="gpu-clock__row">
              <button type="button" className="btn btn--sm" onClick={() => void copyCommand()}>
                {copied ? tc("actions.copied") : tc("actions.copy")}
              </button>
            </div>
          </>
        )}
      </details>
      {loadError && <p className="field-hint is-warn" role="status">{t("gpuClock.refreshError", { message: loadError })}</p>}
      {message && (
        <p className={`field-hint ${message.ok ? "is-ok" : "is-warn"}`} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}