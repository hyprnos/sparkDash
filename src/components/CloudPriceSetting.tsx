import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchEinkPricing,
  fetchEinkConfig,
  refreshEinkPricing,
  saveEinkConfig,
  type EinkPriceAssignment,
  type EinkPriceModel,
  type EinkPriceProfile,
  type EinkPricing,
} from "./EinkPage/einkClient";
import { fetchLlmTokenCost } from "../api/llmTokenClient";
import "../styles/eink.css";

/** Formats an epoch millis for the "last synced" line, or null when it was never synced. */
function fmtTime(ts: number | null): string | null {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return null;
  }
}

/**
 * Cloud-price settings, shared by the Tokens page estimate and the e-paper tag.
 * Lives in the settings dialog so both surfaces read one configuration.
 */
export function CloudPriceSetting() {
  const { t } = useTranslation("eink");
  const [pricing, setPricing] = useState<EinkPricing | null>(null);
  const [models, setModels] = useState<EinkPriceModel[]>([]);
  const [endpoints, setEndpoints] = useState<{ key: string; sparkId: string; port: number; modelId: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchEinkPricing(), fetchEinkConfig(), fetchLlmTokenCost("all").catch(() => null)])
      .then(([price, config, cost]) => {
        if (cancelled) return;
        setModels(price.models);
        setPricing(config.config.pricing);
        const seen = new Map<string, { key: string; sparkId: string; port: number; modelId: string }>();
        for (const group of cost?.groups ?? []) {
          const key = `${group.sparkId}:${group.port}`;
          if (!seen.has(key)) seen.set(key, { key, sparkId: group.sparkId, port: group.port, modelId: "" });
        }
        setEndpoints([...seen.values()]);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const profiles = pricing?.profiles ?? [];
  const assignments = pricing?.assignments ?? [];

  const withProfile = (index: number, patch: Partial<EinkPriceProfile>): EinkPriceProfile[] =>
    profiles.map((profile, i) => (i === index ? { ...profile, ...patch } : profile));

  const setAssignment = (endpoint: { sparkId: string; port: number }, profileId: string) => {
    if (!pricing) return;
    const rest = assignments.filter((rule) => !(rule.sparkId === endpoint.sparkId && rule.port === endpoint.port && !rule.modelId));
    const next: EinkPriceAssignment[] = profileId
      ? [...rest, { sparkId: endpoint.sparkId, port: endpoint.port, modelId: "", profileId }]
      : rest;
    setPricing({ ...pricing, assignments: next });
  };

  const save = useCallback(async () => {
    if (!pricing) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const payload = await saveEinkConfig({ pricing });
      setPricing(payload.config.pricing);
      setNotice(t("pricing.saved"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [pricing, t]);

  const sync = useCallback(async () => {
    setBusy("sync");
    setError(null);
    setNotice(null);
    try {
      const payload = await refreshEinkPricing();
      setModels(payload.models);
      setPricing(payload.pricing);
      setNotice(t("pricing.synced"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [t]);

  if (!pricing) {
    return <p className="eink-meta">{error ?? t("pricing.loading")}</p>;
  }

  const updated = fmtTime(pricing.updatedAt);

  return (
    <div className="eink-sliders">
      <label className="field">
        <span>{t("pricing.model")}</span>
        <select
          value={pricing.modelId}
          onChange={(e) => setPricing({ ...pricing, modelId: e.target.value })}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
          <option value="custom">{t("pricing.custom")}</option>
        </select>
      </label>
      <label className="field">
        <span>{t("pricing.tariff")}</span>
        <select
          value={pricing.tariff}
          onChange={(e) => setPricing({ ...pricing, tariff: e.target.value as EinkPricing["tariff"] })}
        >
          <option value="auto">{t("pricing.tariffAuto")}</option>
          <option value="off-peak">{t("pricing.offPeak")}</option>
          <option value="peak">{t("pricing.peak")}</option>
        </select>
      </label>
      {models.find((m) => m.id === pricing.modelId)?.currency === "USD" ? (
        <label className="field">
          <span>{t("pricing.fx")}</span>
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
            <span>{t("pricing.name")}</span>
            <input
              type="text"
              maxLength={40}
              value={pricing.label}
              onChange={(e) => setPricing({ ...pricing, label: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t("pricing.cacheHit")}</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={pricing.cacheHitPrice}
              onChange={(e) => setPricing({ ...pricing, cacheHitPrice: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>{t("pricing.cacheMiss")}</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={pricing.cacheMissPrice}
              onChange={(e) => setPricing({ ...pricing, cacheMissPrice: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>{t("pricing.output")}</span>
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
      <div className="eink-profiles" style={{ gridColumn: "1 / -1" }}>
        <div className="eink-profiles__head">
          <strong>{t("pricing.profilesTitle")}</strong>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              const next = profiles.length + 1;
              const profile: EinkPriceProfile = {
                id: `profile-${Date.now().toString(36)}`,
                name: t("pricing.profileDefaultName", { n: next }),
                modelId: "deepseek-flash",
                tariff: "auto",
                label: "",
                cacheHitPrice: 0,
                cacheMissPrice: 0,
                outputPrice: 0,
                fxRate: 7.2,
              };
              setPricing({ ...pricing, profiles: [...profiles, profile] });
            }}
          >
            {t("pricing.profileAdd")}
          </button>
        </div>
        <p className="eink-meta">{t("pricing.profilesHelp")}</p>
        {profiles.length === 0 ? <p className="eink-meta">{t("pricing.profilesEmpty")}</p> : null}
        {profiles.map((profile, index) => (
          <div className="eink-profile" key={profile.id}>
            <label className="field">
              <span>{t("pricing.profileName")}</span>
              <input
                type="text"
                maxLength={40}
                value={profile.name}
                onChange={(e) => setPricing({ ...pricing, profiles: withProfile(index, { name: e.target.value }) })}
              />
            </label>
            <label className="field">
              <span>{t("pricing.model")}</span>
              <select
                value={profile.modelId}
                onChange={(e) => setPricing({ ...pricing, profiles: withProfile(index, { modelId: e.target.value }) })}
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("pricing.tariff")}</span>
              <select
                value={profile.tariff}
                onChange={(e) =>
                  setPricing({ ...pricing, profiles: withProfile(index, { tariff: e.target.value as EinkPriceProfile["tariff"] }) })
                }
              >
                <option value="auto">{t("pricing.tariffAuto")}</option>
                <option value="off-peak">{t("pricing.offPeak")}</option>
                <option value="peak">{t("pricing.peak")}</option>
              </select>
            </label>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                const kept = profiles.filter((_, i) => i !== index);
                const stillUsed = new Set(kept.map((p) => p.id));
                setPricing({
                  ...pricing,
                  profiles: kept,
                  assignments: assignments.filter((rule) => stillUsed.has(rule.profileId)),
                });
              }}
            >
              {t("pricing.profileRemove")}
            </button>
          </div>
        ))}

        <div className="eink-profiles__head" style={{ marginTop: 10 }}>
          <strong>{t("pricing.assignTitle")}</strong>
        </div>
        <p className="eink-meta">{t("pricing.assignHelp")}</p>
        {endpoints.length === 0 ? <p className="eink-meta">{t("pricing.assignEmpty")}</p> : null}
        {endpoints.map((endpoint) => (
          <label className="field" key={endpoint.key}>
            <span>{endpoint.sparkId}:{endpoint.port}</span>
            <select
              value={assignments.find((rule) => rule.sparkId === endpoint.sparkId && rule.port === endpoint.port)?.profileId ?? ""}
              onChange={(e) => setAssignment(endpoint, e.target.value)}
            >
              <option value="">{t("pricing.assignDefault")}</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div className="eink-actions" style={{ gridColumn: "1 / -1" }}>
        <button type="button" className="btn btn--sm" onClick={() => void save()} disabled={busy !== null}>
          {busy === "save" ? t("pricing.saving") : t("pricing.save")}
        </button>
        <button type="button" className="btn btn--sm" onClick={() => void sync()} disabled={busy !== null}>
          {busy === "sync" ? t("pricing.syncing") : t("pricing.sync")}
        </button>
        <span className="eink-meta">{t("pricing.updated", { time: updated ?? t("pricing.never") })}</span>
      </div>
      {notice ? <p className="eink-note eink-note--ok" style={{ gridColumn: "1 / -1" }}>{notice}</p> : null}
      {error ? <p className="eink-note eink-note--error" style={{ gridColumn: "1 / -1" }}>{error}</p> : null}
    </div>
  );
}