import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../../styles/eink.css";
import {
  clearEinkBackground,
  fetchEinkAlgorithms,
  fetchEinkConfig,
  fetchEinkDevices,
  fetchEinkPreview,
  pushEinkNow,
  saveEinkConfig,
  uploadEinkBackground,
  type EinkConfig,
  type EinkDevice,
  type EinkStatus,
} from "./einkClient";

const INTERVAL_PRESETS = [15, 30, 60, 180];

function fmtTime(ts: number | null): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
}

export function EinkPage() {
  const { t } = useTranslation("eink");
  const [config, setConfig] = useState<EinkConfig | null>(null);
  const [status, setStatus] = useState<EinkStatus | null>(null);
  const [devices, setDevices] = useState<EinkDevice[]>([]);
  const [algorithms, setAlgorithms] = useState<string[]>(["floyd-steinberg"]);
  const [savedSignature, setSavedSignature] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);

  const replacePreview = useCallback((url: string | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = url;
    setPreviewUrl(url);
  }, []);

  const loadPreview = useCallback(
    async (patch?: Partial<EinkConfig>) => {
      try {
        replacePreview(await fetchEinkPreview(patch));
      } catch (err) {
        replacePreview(null);
        setError((err as Error).message);
      }
    },
    [replacePreview]
  );

  const load = useCallback(async () => {
    try {
      const payload = await fetchEinkConfig();
      setConfig(payload.config);
      setSavedSignature(JSON.stringify(payload.config));
      setStatus(payload.status);
      setError(null);
      await loadPreview();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [loadPreview]);

  useEffect(() => {
    void fetchEinkAlgorithms().then((list) => {
      if (list.length) setAlgorithms(list);
    });
  }, []);

  useEffect(() => {
    void load();
    return () => replacePreview(null);
  }, [load, replacePreview]);

  // Keep the preview in step with the form, including unsaved edits: the panel
  // frame the user is about to push is always the one shown.
  useEffect(() => {
    if (!config) return;
    const timer = setTimeout(() => void loadPreview(config), 450);
    return () => clearTimeout(timer);
  }, [config, loadPreview]);

  const persist = useCallback(
    async (patch: Partial<EinkConfig>) => {
      setBusy("save");
      setError(null);
      try {
        // Always send the whole form: a bare patch would leave every other
        // unsaved edit behind (and the response then reset the form to it).
        const payload = await saveEinkConfig({ ...(config as EinkConfig), ...patch });
        setConfig(payload.config);
        setSavedSignature(JSON.stringify(payload.config));
        setStatus(payload.status);
        setNotice(t("notice.saved"));
        await loadPreview(payload.config);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [config, loadPreview, t]
  );

  const scan = useCallback(async () => {
    setBusy("scan");
    setError(null);
    setNotice(null);
    try {
      const found = await fetchEinkDevices();
      setDevices(found);
      setNotice(found.length ? t("device.found", { count: found.length }) : t("device.notFound"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [t]);

  const push = useCallback(async () => {
    setBusy("push");
    setError(null);
    setNotice(null);
    try {
      // Push what the form shows: persist the edits first, then refresh the panel.
      if (config) {
        const saved = await saveEinkConfig(config);
        setConfig(saved.config);
        setStatus(saved.status);
      }
      const result = await pushEinkNow();
      setStatus(result.status);
      const pushed = (result as { scene?: { ditherAlgorithm?: string } }).scene;
      setNotice(
        t("notice.pushed", {
          algorithm: pushed?.ditherAlgorithm ?? config?.ditherAlgorithm ?? "?",
          seconds: (result.durationMs / 1000).toFixed(1),
        })
      );
      setSavedSignature(JSON.stringify(config));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [config, t]);

  const onBackground = useCallback(
    async (file: File | null) => {
      if (!file) return;
      setBusy("background");
      setError(null);
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error(t("notice.imageFailed")));
          reader.readAsDataURL(file);
        });
        const payload = await uploadEinkBackground(dataUrl);
        setConfig(payload.config);
        setStatus(payload.status);
        setNotice(t("notice.background"));
        await loadPreview();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [loadPreview, t]
  );

  if (!config) {
    return (
      <section className="eink-page">
        <header className="eink-head">
          <h1>{t("title")}</h1>
          <p>{t("intro")}</p>
        </header>
        {error ? <p className="eink-note eink-note--error">{error}</p> : <p className="eink-note">{t("loading")}</p>}
      </section>
    );
  }

  return (
    <section className="eink-page">
      <header className="eink-head">
        <div>
          <h1>{t("title")}</h1>
          <p>{t("introRefresh")}</p>
        </div>
        <label className="eink-switch">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => void persist({ enabled: e.target.checked })}
            disabled={busy !== null}
          />
          <span>{config.enabled ? t("autoOn") : t("autoOff")}</span>
        </label>
      </header>

      {error ? <p className="eink-note eink-note--error">{error}</p> : null}
      {notice ? <p className="eink-note eink-note--ok">{notice}</p> : null}

      <div className="eink-grid">
        <div className="panel eink-card">
          <h2>{t("device.title")}</h2>
          <p className="eink-meta">
            {t("device.current", { name: config.device.name || t("device.none") })}
            {config.device.address ? t("device.address", { address: config.device.address }) : ""}
          </p>
          <div className="eink-actions">
            <button type="button" className="btn btn--sm" onClick={() => void scan()} disabled={busy !== null}>
              {busy === "scan" ? t("device.scanning") : t("device.scan")}
            </button>
          </div>
          {devices.length ? (
            <ul className="eink-devices">
              {devices.map((d) => (
                <li key={d.address}>
                  <button
                    type="button"
                    className={`eink-device ${d.address === config.device.address ? "is-active" : ""}`}
                    onClick={() => void persist({ device: { address: d.address, name: d.name } })}
                    disabled={busy !== null}
                  >
                    <span className="eink-device__name">{d.name}</span>
                    <span className="eink-device__rssi">{typeof d.rssi === "number" ? `${d.rssi} dBm` : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <label className="field">
            <span>{t("device.alias")}</span>
            <input
              type="text"
              value={config.device.name}
              onChange={(e) => setConfig({ ...config, device: { ...config.device, name: e.target.value } })}
            />
          </label>
        </div>

        <div className="panel eink-card">
          <h2>{t("cadence.title")}</h2>
          <label className="field">
            <span>{t("cadence.interval")}</span>
            <input
              type="number"
              min={5}
              max={1440}
              value={config.intervalMinutes}
              onChange={(e) => setConfig({ ...config, intervalMinutes: Number(e.target.value) })}
            />
          </label>
          <div className="eink-actions">
            {INTERVAL_PRESETS.map((m) => (
              <button
                key={m}
                type="button"
                className={`btn btn--sm ${config.intervalMinutes === m ? "is-active" : ""}`}
                onClick={() => setConfig({ ...config, intervalMinutes: m })}
              >
                {t("cadence.minutes", { minutes: m })}
              </button>
            ))}
          </div>
          <p className="eink-meta">
            {t("cadence.lastOk", { time: fmtTime(status?.lastOkAt ?? null) })}
            {status?.lastDurationMs ? t("cadence.duration", { seconds: (status.lastDurationMs / 1000).toFixed(1) }) : ""}
          </p>
          <p className="eink-meta">
            {t("cadence.battery", { voltage: status?.batteryMv ? `${(status.batteryMv / 1000).toFixed(2)} V` : "—" })}
            {status?.lastError ? t("cadence.errorBelow") : ""}
          </p>
          {status?.lastError ? <p className="eink-note eink-note--error">{status.lastError}</p> : null}
        </div>

        <div className="panel eink-card">
          <h2>{t("content.title")}</h2>
          <fieldset className="eink-fieldset">
            <label>
              <input
                type="checkbox"
                checked={config.sections.headline}
                onChange={(e) => setConfig({ ...config, sections: { ...config.sections, headline: e.target.checked } })}
              />
              <span>{t("content.headline")}</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={config.sections.stats}
                onChange={(e) => setConfig({ ...config, sections: { ...config.sections, stats: e.target.checked } })}
              />
              <span>{t("content.stats")}</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={config.sections.rows}
                onChange={(e) => setConfig({ ...config, sections: { ...config.sections, rows: e.target.checked } })}
              />
              <span>{t("content.rows")}</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={config.sections.cost}
                onChange={(e) => setConfig({ ...config, sections: { ...config.sections, cost: e.target.checked } })}
              />
              <span>{t("content.cost")}</span>
            </label>
          </fieldset>
          <div className="eink-row">
            <label className="field">
              <span>{t("content.pigment")}</span>
              <select
                value={config.pigment}
                onChange={(e) => setConfig({ ...config, pigment: e.target.value === "red" ? "red" : "yellow" })}
              >
                <option value="yellow">{t("content.yellow")}</option>
                <option value="red">{t("content.red")}</option>
              </select>
            </label>
            <label className="field">
              <span>{t("content.theme")}</span>
              <select
                value={config.theme}
                onChange={(e) => setConfig({ ...config, theme: e.target.value === "light" ? "light" : "dark" })}
              >
                <option value="dark">{t("content.dark")}</option>
                <option value="light">{t("content.light")}</option>
              </select>
            </label>
          </div>
          <div className="eink-sliders">
            <label className="field">
              <span>{t("content.backgroundZoom", { value: config.backgroundZoom.toFixed(2) })}</span>
              <input
                type="range"
                min={1}
                max={4}
                step={0.05}
                value={config.backgroundZoom}
                onChange={(e) => setConfig({ ...config, backgroundZoom: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>{t("content.offsetX", { value: config.backgroundOffsetX.toFixed(2) })}</span>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.02}
                value={config.backgroundOffsetX}
                onChange={(e) => setConfig({ ...config, backgroundOffsetX: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>{t("content.offsetY", { value: config.backgroundOffsetY.toFixed(2) })}</span>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.02}
                value={config.backgroundOffsetY}
                onChange={(e) => setConfig({ ...config, backgroundOffsetY: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>{t("content.brightness", { value: config.backgroundBrightness })}</span>
              <input
                type="range"
                min={-100}
                max={100}
                step={1}
                value={config.backgroundBrightness}
                onChange={(e) => setConfig({ ...config, backgroundBrightness: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>{t("content.contrast", { value: config.backgroundContrast })}</span>
              <input
                type="range"
                min={-100}
                max={100}
                step={1}
                value={config.backgroundContrast}
                onChange={(e) => setConfig({ ...config, backgroundContrast: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>{t("content.dither")}</span>
              <select
                value={config.ditherAlgorithm}
                onChange={(e) => setConfig({ ...config, ditherAlgorithm: e.target.value })}
              >
                {algorithms.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("content.ditherStrength", { value: Math.round(config.ditherStrength * 100) })}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={config.ditherStrength}
                onChange={(e) => setConfig({ ...config, ditherStrength: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="eink-row">
            <label className="field">
              <span>{t("content.titleText")}</span>
              <input
                type="text"
                maxLength={24}
                value={config.title}
                onChange={(e) => setConfig({ ...config, title: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t("content.footerText")}</span>
              <input
                type="text"
                maxLength={48}
                placeholder={t("content.footerPlaceholder")}
                value={config.footer}
                onChange={(e) => setConfig({ ...config, footer: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t("content.textProtection")}</span>
              <select
                value={config.textProtection}
                onChange={(e) => setConfig({ ...config, textProtection: e.target.value as EinkConfig["textProtection"] })}
              >
                <option value="auto">{t("content.protectAuto")}</option>
                <option value="halo">{t("content.protectHalo")}</option>
                <option value="plate">{t("content.protectPlate")}</option>
                <option value="off">{t("content.protectOff")}</option>
              </select>
            </label>
            <label className="field">
              <span>{t("content.haloWidth")}</span>
              <input
                type="number"
                min={1}
                max={4}
                value={config.haloWidth}
                onChange={(e) => setConfig({ ...config, haloWidth: Number(e.target.value) || 2 })}
              />
            </label>
          </div>
          <div className="eink-row">
            <label className="field">
              <span>{t("content.background")}</span>
              <input
                type="file"
                accept="image/png,image/jpeg"
                onChange={(e) => void onBackground(e.target.files?.[0] ?? null)}
                disabled={busy !== null}
              />
            </label>
            {config.background ? (
              <button type="button" className="btn btn--sm" onClick={() => void persist({ background: null })}>
                {t("content.removeBackground")}
              </button>
            ) : null}
          </div>
          <div className="eink-actions">
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void persist({})} disabled={busy !== null}>
              {busy === "save" ? t("content.saving") : t("content.save")}
            </button>
            <button type="button" className="btn btn--sm" onClick={() => void push()} disabled={busy !== null}>
              {busy === "push" ? t("content.pushing") : t("content.push")}
            </button>
          </div>
        </div>

        <div className="panel eink-card eink-card--preview">
          <h2>
            {t("preview.title")}
            {savedSignature && config && JSON.stringify(config) !== savedSignature ? (
              <span className="eink-badge">{t("preview.unsaved")}</span>
            ) : (
              <span className="eink-badge eink-badge--ok">{t("preview.saved")}</span>
            )}
          </h2>
          {previewUrl ? (
            <img className="eink-preview" src={previewUrl} alt={t("preview.alt")} />
          ) : (
            <p className="eink-note">{t("preview.none")}</p>
          )}
          <p className="eink-meta">{t("preview.meta", { url: status?.bridgeUrl ?? "—" })}</p>
        </div>
      </div>
    </section>
  );
}