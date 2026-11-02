import { useCallback, useEffect, useState } from "react";
import {
  fetchEinkPricing,
  fetchEinkConfig,
  refreshEinkPricing,
  saveEinkConfig,
  type EinkPriceModel,
  type EinkPricing,
} from "./EinkPage/einkClient";
import "../styles/eink.css";

/** Formats an epoch millis for the "last synced" line. */
function fmtTime(ts: number | null): string {
  if (!ts) return "尚未同步";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "尚未同步";
  }
}

/**
 * Cloud-price settings, shared by the Tokens page estimate and the e-paper tag.
 * Lives in the settings dialog so both surfaces read one configuration.
 */
export function CloudPriceSetting() {
  const [pricing, setPricing] = useState<EinkPricing | null>(null);
  const [models, setModels] = useState<EinkPriceModel[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchEinkPricing(), fetchEinkConfig()])
      .then(([price, config]) => {
        if (cancelled) return;
        setModels(price.models);
        setPricing(config.config.pricing);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    if (!pricing) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const payload = await saveEinkConfig({ pricing });
      setPricing(payload.config.pricing);
      setNotice("价格设置已保存");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [pricing]);

  const sync = useCallback(async () => {
    setBusy("sync");
    setError(null);
    setNotice(null);
    try {
      const payload = await refreshEinkPricing();
      setModels(payload.models);
      setPricing(payload.pricing);
      setNotice("已从 DeepSeek 官网同步价格");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  if (!pricing) {
    return <p className="eink-meta">{error ?? "正在加载价格…"}</p>;
  }

  return (
    <div className="eink-sliders">
      <label className="field">
        <span>对照模型</span>
        <select
          value={pricing.modelId}
          onChange={(e) => setPricing({ ...pricing, modelId: e.target.value })}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
          <option value="custom">自定义单价</option>
        </select>
      </label>
      <label className="field">
        <span>时段</span>
        <select
          value={pricing.tariff}
          onChange={(e) => setPricing({ ...pricing, tariff: e.target.value as EinkPricing["tariff"] })}
        >
          <option value="auto">自动（按北京时间判高峰）</option>
          <option value="off-peak">空闲时段</option>
          <option value="peak">高峰时段</option>
        </select>
      </label>
      {models.find((m) => m.id === pricing.modelId)?.currency === "USD" ? (
        <label className="field">
          <span>美元汇率（元/$）</span>
          <input
            type="number"
            min={1}
            max={20}
            step={0.01}
            value={pricing.fxRate}
            onChange={(e) => setPricing({ ...pricing, fxRate: Number(e.target.value) })}
          />
        </label>
      ) : null}
      {pricing.modelId === "custom" ? (
        <>
          <label className="field">
            <span>名称</span>
            <input
              type="text"
              maxLength={40}
              value={pricing.label}
              onChange={(e) => setPricing({ ...pricing, label: e.target.value })}
            />
          </label>
          <label className="field">
            <span>缓存命中（元/百万）</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={pricing.cacheHitPrice}
              onChange={(e) => setPricing({ ...pricing, cacheHitPrice: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>缓存未命中（元/百万）</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={pricing.cacheMissPrice}
              onChange={(e) => setPricing({ ...pricing, cacheMissPrice: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>输出（元/百万）</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={pricing.outputPrice}
              onChange={(e) => setPricing({ ...pricing, outputPrice: Number(e.target.value) })}
            />
          </label>
        </>
      ) : null}
      <div className="eink-actions" style={{ gridColumn: "1 / -1" }}>
        <button type="button" className="btn btn--sm" onClick={() => void save()} disabled={busy !== null}>
          {busy === "save" ? "保存中…" : "保存价格设置"}
        </button>
        <button type="button" className="btn btn--sm" onClick={() => void sync()} disabled={busy !== null}>
          {busy === "sync" ? "同步中…" : "从官网同步价格"}
        </button>
        <span className="eink-meta">更新于 {fmtTime(pricing.updatedAt)}</span>
      </div>
      {notice ? <p className="eink-note eink-note--ok" style={{ gridColumn: "1 / -1" }}>{notice}</p> : null}
      {error ? <p className="eink-note eink-note--error" style={{ gridColumn: "1 / -1" }}>{error}</p> : null}
    </div>
  );
}