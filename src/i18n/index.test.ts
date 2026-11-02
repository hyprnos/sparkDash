import { afterEach, describe, expect, it, vi } from "vitest";
import { detectLocale, i18n, LOCALES, LOCALE_STORAGE_KEY, normalizeLocale, setLocale } from "./index";

/** jsdom exposes "en-US"; tests set both the preference list and its primary entry. */
function setBrowserLanguages(languages: string[], primary = languages[0] ?? "") {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);
  vi.spyOn(navigator, "language", "get").mockReturnValue(primary);
}

function flatten(value: unknown, prefix = "", result = new Map<string, string>()): Map<string, string> {
  if (!value || typeof value !== "object") return result;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof entry === "string") result.set(fullKey, entry);
    else flatten(entry, fullKey, result);
  }
  return result;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await setLocale("en");
  localStorage.clear();
});

describe("language tags", () => {
  it("maps the shipped languages, including Chinese script and region variants", () => {
    for (const tag of ["zh", "zh-CN", "zh-SG", "zh_MY", "zh-Hans", "zh-Hans-CN"]) expect(normalizeLocale(tag)).toBe("zh-CN");
    for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW"]) expect(normalizeLocale(tag)).toBe("zh-TW");
    for (const tag of ["en", "en-GB"]) expect(normalizeLocale(tag)).toBe("en");
    for (const tag of ["ja", "ja-JP"]) expect(normalizeLocale(tag)).toBe("ja");
    for (const tag of ["ko", "ko-KR"]) expect(normalizeLocale(tag)).toBe("ko");
    for (const tag of ["es", "es-419"]) expect(normalizeLocale(tag)).toBe("es");
    for (const tag of ["fr", "fr-CA"]) expect(normalizeLocale(tag)).toBe("fr");
    for (const tag of ["de", "de-AT"]) expect(normalizeLocale(tag)).toBe("de");
    for (const tag of ["pt", "pt-BR", "pt-PT"]) expect(normalizeLocale(tag)).toBe("pt-BR");
    for (const tag of ["ru", "ru-RU"]) expect(normalizeLocale(tag)).toBe("ru");
    for (const tag of ["it", "it-CH"]) expect(normalizeLocale(tag)).toBe("it");
    for (const tag of ["ar", "ar-EG", "ar-SA"]) expect(normalizeLocale(tag)).toBe("ar");
    for (const tag of ["", "  ", "nl-NL", "sv", null, undefined]) expect(normalizeLocale(tag)).toBeNull();
  });

  it("prefers the saved choice over the browser languages and ignores unsupported saved values", () => {
    setBrowserLanguages(["zh-TW"]);
    localStorage.setItem(LOCALE_STORAGE_KEY, "de");
    expect(detectLocale()).toBe("de");
    localStorage.setItem(LOCALE_STORAGE_KEY, "unknown");
    expect(detectLocale()).toBe("zh-TW");
  });

  it("takes the first supported language from the browser preference list", () => {
    localStorage.clear();
    setBrowserLanguages(["nl-NL", "ja-JP", "en-US"]);
    expect(detectLocale()).toBe("ja");
  });

  it("falls back to English when the system language is unknown", () => {
    localStorage.clear();
    setBrowserLanguages(["xx-YY", "zz"]);
    expect(detectLocale()).toBe("en");
  });

  it("falls back to English when the browser reports no languages", () => {
    localStorage.clear();
    setBrowserLanguages([], "");
    expect(detectLocale()).toBe("en");
  });

  it("remembers an explicit choice and reads it back on the next visit", async () => {
    localStorage.clear();
    setBrowserLanguages(["de-DE"]);
    await setLocale("ar");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ar");
    expect(detectLocale()).toBe("ar");
  });
});

describe("document direction and metadata", () => {
  it("switches the document to right-to-left for Arabic and back for other locales", async () => {
    await setLocale("ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
    await setLocale("ja");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("ja");
    expect(document.title).toBe("sparkDash — マルチ DGX Spark 監視ダッシュボード");
    await setLocale("en");
    expect(document.title).toBe("sparkDash — Multi-DGX Spark Monitoring Dashboard");
  });

  it("switches immediately, updates HTML, and survives preference reads", async () => {
    await setLocale("zh-CN");
    expect(i18n.resolvedLanguage).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.documentElement.dir).toBe("ltr");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
    expect(detectLocale()).toBe("zh-CN");
    await setLocale("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("keeps switching when storage access throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    await expect(setLocale("zh-CN")).resolves.toBeUndefined();
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(() => detectLocale()).not.toThrow();
  });
});

describe("catalogs", () => {
  it("ships the same complete key set for every locale and namespace", () => {
    const namespaces = ["settings", "language", "nav", "common"];
    const source = new Map<string, string>();
    for (const namespace of namespaces) {
      for (const [key, value] of flatten(i18n.getResourceBundle("en", namespace))) source.set(`${namespace}.${key}`, value);
    }
    expect(source.size).toBeGreaterThan(150);
    for (const locale of LOCALES) {
      const target = new Map<string, string>();
      for (const namespace of namespaces) {
        const bundle = i18n.getResourceBundle(locale, namespace);
        expect(bundle, `${locale}/${namespace}`).toBeTruthy();
        for (const [key, value] of flatten(bundle)) target.set(`${namespace}.${key}`, value);
      }
      expect([...target.keys()].sort(), locale).toEqual([...source.keys()].sort());
      for (const [key, value] of target) expect(value.trim(), `${locale} ${key}`).not.toBe("");
    }
  });
});

describe("English source and plain i18next formatting", () => {
  it("falls back to the English catalog when a Chinese entry is unavailable", async () => {
    i18n.addResourceBundle("en", "fixture", { greeting: "Hello, {{name}}", items_one: "{{count}} item", items_other: "{{count}} items" });
    try {
      await setLocale("zh-CN");
      expect(i18n.t("fixture:greeting", { name: "GPU <1>" })).toBe("Hello, GPU <1>");
      await setLocale("en");
      expect(i18n.t("fixture:items", { count: 1 })).toBe("1 item");
      expect(i18n.t("fixture:items", { count: 2 })).toBe("2 items");
    } finally {
      i18n.removeResourceBundle("en", "fixture");
    }
  });
});