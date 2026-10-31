import { useCallback, useEffect, useRef, useState } from "react";
import "../../styles/eink.css";
import {
  clearEinkBackground,
  fetchEinkAlgorithms,
  fetchEinkConfig,
  fetchEinkPricing,
  refreshEinkPricing,
  fetchEinkDevices,
  fetchEinkPreview,
  pushEinkNow,
  saveEinkConfig,
  uploadEinkBackground,
  type EinkConfig,
  type EinkDevice,
  type EinkPriceModel,
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
  const [algorithms, setAlgorithms] = useState<string[]>(["floyd-steinberg"]);
  const [priceModels, setPriceModels] = useState<EinkPriceModel[]>([]);
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
    void fetchEinkAlgorithms().then((list) => {
      if (list.length) setAlgorithms(list);
    });
    void fetchEinkPricing()
      .then((payload) => setPriceModels(payload.models))
      .catch(() => undefined);
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

  const syncPrices = useCallback(async () => {
    setBusy("pricing");
    setError(null);
    setNotice(null);
    try {
      const payload = await refreshEinkPricing();
      setPriceModels(payload.models);
      setConfig((current) => (current ? { ...current, pricing: payload.pricing } : current));
      setNotice("已同步官网价格");
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
            <label>
              <input
                type="checkbox"
                checked={config.sections.cost}
                onChange={(e) => setConfig({ ...config, sections: { ...config.sections, cost: e.target.checked } })}
              />
              <span>云价换算（元）</span>
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
          <div className="eink-sliders">
            <label className="field">
              <span>背景缩放 {config.backgroundZoom.toFixed(2)}×</span>
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
              <span>左右平移 {config.backgroundOffsetX.toFixed(2)}</span>
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
              <span>上下平移 {config.backgroundOffsetY.toFixed(2)}</span>
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
              <span>亮度 {config.backgroundBrightness}</span>
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
              <span>对比度 {config.backgroundContrast}</span>
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
              <span>抖动算法</span>
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
              <span>抖动强度 {Math.round(config.ditherStrength * 100)}%</span>
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
              <span>标题文案</span>
              <input
                type="text"
                maxLength={24}
                value={config.title}
                onChange={(e) => setConfig({ ...config, title: e.target.value })}
              />
            </label>
            <label className="field">
              <span>页脚文案（留空用默认，{"{time}"} 表示刷新时间）</span>
              <input
                type="text"
                maxLength={48}
                placeholder="留空 = 每 N 分钟刷新"
                value={config.footer}
                onChange={(e) => setConfig({ ...config, footer: e.target.value })}
              />
            </label>
            <label className="field">
              <span>背景处理（文字优先）</span>
              <select
                value={config.textProtection}
                onChange={(e) => setConfig({ ...config, textProtection: e.target.value as EinkConfig["textProtection"] })}
              >
                <option value="auto">智能：小字紧贴描底，大字只描一圈</option>
                <option value="halo">全部文字描边（背景完全不动）</option>
                <option value="plate">文字区整块留白</option>
                <option value="off">不处理（背景可能切字）</option>
              </select>
            </label>
            <label className="field">
              <span>描边粗细（1-4 像素）</span>
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

        <div className="panel eink-card">
          <h2>成本换算（元 / 百万 tokens）</h2>
          <div className="eink-row">
            <label className="field">
              <span>对照模型</span>
              <select
                value={config.pricing.modelId}
                onChange={(e) => setConfig({ ...config, pricing: { ...config.pricing, modelId: e.target.value } })}
              >
                {priceModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                <option value="custom">自定义单价</option>
              </select>
            </label>
            <label className="field">
              <span>时段</span>
              <select
                value={config.pricing.tariff}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    pricing: { ...config.pricing, tariff: e.target.value as "auto" | "peak" | "off-peak" },
                  })
                }
              >
                <option value="auto">自动（按北京时间）</option>
                <option value="off-peak">空闲时段</option>
                <option value="peak">高峰时段</option>
              </select>
            </label>
          </div>
          {config.pricing.modelId === "custom" ? (
            <div className="eink-row">
              <label className="field">
                <span>名称</span>
                <input
                  type="text"
                  maxLength={40}
                  value={config.pricing.label}
                  onChange={(e) => setConfig({ ...config, pricing: { ...config.pricing, label: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>缓存命中（元/M）</span>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={config.pricing.cacheHitPrice}
                  onChange={(e) =>
                    setConfig({ ...config, pricing: { ...config.pricing, cacheHitPrice: Number(e.target.value) } })
                  }
                />
              </label>
              <label className="field">
                <span>缓存未命中（元/M）</span>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={config.pricing.cacheMissPrice}
                  onChange={(e) =>
                    setConfig({ ...config, pricing: { ...config.pricing, cacheMissPrice: Number(e.target.value) } })
                  }
                />
              </label>
              <label className="field">
                <span>输出（元/M）</span>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={config.pricing.outputPrice}
                  onChange={(e) =>
                    setConfig({ ...config, pricing: { ...config.pricing, outputPrice: Number(e.target.value) } })
                  }
                />
              </label>
            </div>
          ) : null}
          <div className="eink-actions">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void syncPrices()}
              disabled={busy !== null}
            >
              {busy === "pricing" ? "同步中…" : "从官网同步价格"}
            </button>
            <span className="eink-meta">
              {config.pricing.updatedAt ? `更新于 ${fmtTime(config.pricing.updatedAt)}` : "尚未同步过官网价格"}
            </span>
          </div>
          <p className="eink-meta">按今日 token 量折算，勾选“云价换算”后显示在墨水屏上。</p>
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