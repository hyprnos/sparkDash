import { useCallback, useEffect, useRef, useState } from "react";
import "../../styles/eink.css";
import {
  clearEinkBackground,
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
  const [config, setConfig] = useState<EinkConfig | null>(null);
  const [status, setStatus] = useState<EinkStatus | null>(null);
  const [devices, setDevices] = useState<EinkDevice[]>([]);
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
      setStatus(payload.status);
      setError(null);
      await loadPreview();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [loadPreview]);

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
        const payload = await saveEinkConfig(patch);
        setConfig(payload.config);
        setStatus(payload.status);
        setNotice("配置已保存");
        await loadPreview(payload.config);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [loadPreview]
  );

  const scan = useCallback(async () => {
    setBusy("scan");
    setError(null);
    setNotice(null);
    try {
      const found = await fetchEinkDevices();
      setDevices(found);
      setNotice(found.length ? `发现 ${found.length} 台设备` : "没扫到墨水屏；确认它没有连在手机上，且距离在几米内");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

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
      setNotice(`已推送到墨水屏，用时 ${(result.durationMs / 1000).toFixed(1)} 秒`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const onBackground = useCallback(
    async (file: File | null) => {
      if (!file) return;
      setBusy("background");
      setError(null);
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("读取图片失败"));
          reader.readAsDataURL(file);
        });
        const payload = await uploadEinkBackground(dataUrl);
        setConfig(payload.config);
        setStatus(payload.status);
        setNotice("背景已更新");
        await loadPreview();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [loadPreview]
  );

  if (!config) {
    return (
      <section className="eink-page">
        <header className="eink-head">
          <h1>E-Paper</h1>
          <p>把舰队 token 用量投到桌上的蓝牙墨水屏。</p>
        </header>
        {error ? <p className="eink-note eink-note--error">{error}</p> : <p className="eink-note">加载中…</p>}
      </section>
    );
  }

  return (
    <section className="eink-page">
      <header className="eink-head">
        <div>
          <h1>E-Paper</h1>
          <p>把舰队 token 用量投到桌上的蓝牙墨水屏。刷新一次约 20 秒，电池供电，别设太勤。</p>
        </div>
        <label className="eink-switch">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => void persist({ enabled: e.target.checked })}
            disabled={busy !== null}
          />
          <span>{config.enabled ? "自动刷新已开启" : "自动刷新已关闭"}</span>
        </label>
      </header>

      {error ? <p className="eink-note eink-note--error">{error}</p> : null}
      {notice ? <p className="eink-note eink-note--ok">{notice}</p> : null}

      <div className="eink-grid">
        <div className="panel eink-card">
          <h2>设备</h2>
          <p className="eink-meta">
            当前：{config.device.name || "未选择"}
            {config.device.address ? ` · ${config.device.address}` : ""}
          </p>
          <div className="eink-actions">
            <button type="button" className="btn btn--sm" onClick={() => void scan()} disabled={busy !== null}>
              {busy === "scan" ? "扫描中…" : "扫描附近墨水屏"}
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
            <span>备用名称（地址为空时按名字找）</span>
            <input
              type="text"
              value={config.device.name}
              onChange={(e) => setConfig({ ...config, device: { ...config.device, name: e.target.value } })}
            />
          </label>
        </div>

        <div className="panel eink-card">
          <h2>刷新节奏</h2>
          <label className="field">
            <span>间隔（分钟，5–1440）</span>
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
                {m} 分钟
              </button>
            ))}
          </div>
          <p className="eink-meta">
            上次成功：{fmtTime(status?.lastOkAt ?? null)}
            {status?.lastDurationMs ? ` · 用时 ${(status.lastDurationMs / 1000).toFixed(1)} 秒` : ""}
          </p>
          <p className="eink-meta">
            电量：{status?.batteryMv ? `${(status.batteryMv / 1000).toFixed(2)} V` : "—"}
            {status?.lastError ? " · 最近错误见下" : ""}
          </p>
          {status?.lastError ? <p className="eink-note eink-note--error">{status.lastError}</p> : null}
        </div>

        <div className="panel eink-card">
          <h2>显示内容</h2>
          <fieldset className="eink-fieldset">
            <label>
              <input
                type="checkbox"
                checked={config.sections.headline}
                onChange={(e) => setConfig({ ...config, sections: { ...config.sections, headline: e.target.checked } })}
              />
              <span>今日 token 大数字</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={config.sections.stats}
                onChange={(e) => setConfig({ ...config, sections: { ...config.sections, stats: e.target.checked } })}
              />
              <span>输入 / 输出 / 缓存命中</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={config.sections.rows}
                onChange={(e) => setConfig({ ...config, sections: { ...config.sections, rows: e.target.checked } })}
              />
              <span>每台 Spark 的用量条</span>
            </label>
          </fieldset>
          <div className="eink-row">
            <label className="field">
              <span>副色（黄/红由面板决定）</span>
              <select
                value={config.pigment}
                onChange={(e) => setConfig({ ...config, pigment: e.target.value === "red" ? "red" : "yellow" })}
              >
                <option value="yellow">黄色</option>
                <option value="red">红色</option>
              </select>
            </label>
            <label className="field">
              <span>主题</span>
              <select
                value={config.theme}
                onChange={(e) => setConfig({ ...config, theme: e.target.value === "light" ? "light" : "dark" })}
              >
                <option value="dark">深色</option>
                <option value="light">浅色</option>
              </select>
            </label>
          </div>
          <div className="eink-row">
            <label className="field">
              <span>背景图</span>
              <input
                type="file"
                accept="image/png,image/jpeg"
                onChange={(e) => void onBackground(e.target.files?.[0] ?? null)}
                disabled={busy !== null}
              />
            </label>
            {config.background ? (
              <button type="button" className="btn btn--sm" onClick={() => void persist({ background: null })}>
                去掉背景
              </button>
            ) : null}
          </div>
          <div className="eink-actions">
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void persist({})} disabled={busy !== null}>
              {busy === "save" ? "保存中…" : "保存"}
            </button>
            <button type="button" className="btn btn--sm" onClick={() => void push()} disabled={busy !== null}>
              {busy === "push" ? "推送中…" : "立即刷新"}
            </button>
          </div>
        </div>

        <div className="panel eink-card eink-card--preview">
          <h2>预览（与屏幕一致）</h2>
          {previewUrl ? (
            <img className="eink-preview" src={previewUrl} alt="墨水屏预览" />
          ) : (
            <p className="eink-note">还没有预览。确认宿主机上的 eink-bridge 已启动。</p>
          )}
          <p className="eink-meta">400 × 300 · 三色抖动 · 桥接：{status?.bridgeUrl ?? "—"}</p>
        </div>
      </div>
    </section>
  );
}