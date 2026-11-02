import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { applyDocumentDirection, isRtlLocale } from "./direction";

/** Every locale sparkDash ships a catalog for. */
export type Locale =
  | "en"
  | "zh-CN"
  | "zh-TW"
  | "ja"
  | "ko"
  | "es"
  | "fr"
  | "de"
  | "pt-BR"
  | "ru"
  | "it"
  | "ar";

/** Picker order: the source language first, then the catalog languages. */
export const LOCALES: readonly Locale[] = [
  "en",
  "zh-CN",
  "zh-TW",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "pt-BR",
  "ru",
  "it",
  "ar",
];

/**
 * Namespaces a translator can work on, one file per area: the shell's settings,
 * language picker, navigation and shared copy, plus one file per dashboard page
 * (`tokens`, `eink`, `overview`) so a page can be translated on its own.
 */
export const NAMESPACES = ["settings", "language", "nav", "common", "tokens", "eink", "overview"] as const;

export const LOCALE_STORAGE_KEY = "sparkdash-locale";

const DEFAULT_LOCALE: Locale = "en";

/** Base language subtags that map straight onto a shipped locale. */
const BASE_LOCALES: Readonly<Record<string, Locale>> = {
  en: "en",
  ja: "ja",
  ko: "ko",
  es: "es",
  fr: "fr",
  de: "de",
  ru: "ru",
  it: "it",
  ar: "ar",
};

/**
 * Maps a BCP 47 tag (or a tag someone typed/stored) onto a shipped locale, or null
 * when sparkDash has no catalog for that language. Chinese resolves by script and
 * region — Traditional for TW/HK/MO and anything marked Hant, Simplified for
 * zh, CN, SG, MY and anything marked Hans — and Portuguese resolves to the
 * Brazilian catalog, the only Portuguese catalog we ship.
 */
export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const tag = value.trim().toLowerCase().replace(/_/g, "-");
  if (!tag) return null;
  const [language, ...subtags] = tag.split("-");
  if (language === "zh") {
    const rest = subtags.join("-");
    if (/(?:^|-)(?:hant|tw|hk|mo)(?:-|$)/.test(rest)) return "zh-TW";
    return "zh-CN";
  }
  if (language === "pt") return "pt-BR";
  return BASE_LOCALES[language] ?? null;
}

/** Browser language preferences, most preferred first. */
function browserLanguageTags(): string[] {
  if (typeof navigator === "undefined") return [];
  const tags: string[] = [];
  const preferred = (navigator as Navigator).languages;
  if (Array.isArray(preferred)) {
    for (const tag of preferred) if (typeof tag === "string" && tag) tags.push(tag);
  }
  if (typeof navigator.language === "string" && navigator.language) tags.push(navigator.language);
  return tags;
}

/**
 * The locale to start in: an explicit choice this browser saved, otherwise the
 * first supported language in the browser's preference list, otherwise English.
 * An unknown system language (Dutch, Swedish, a malformed tag) falls back to `en`.
 */
export function detectLocale(): Locale {
  try {
    const stored = normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
    if (stored) return stored;
  } catch {
    /* Browser storage is optional. */
  }
  for (const tag of browserLanguageTags()) {
    const match = normalizeLocale(tag);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

/**
 * Catalogs are bundled, not fetched: one JSON file per namespace in
 * src/locales/<locale>/. Adding a language is a directory plus a LOCALES entry.
 */
const catalogModules = import.meta.glob<Record<string, unknown>>("../locales/*/*.json", {
  eager: true,
  import: "default",
});

function catalogResources(): Record<string, Record<string, Record<string, unknown>>> {
  const resources: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [path, catalog] of Object.entries(catalogModules)) {
    const match = /\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
    if (!match) continue;
    const [, language, namespace] = match;
    if (!LOCALES.includes(language as Locale)) continue;
    if (!NAMESPACES.includes(namespace as (typeof NAMESPACES)[number])) continue;
    (resources[language] ??= {})[namespace] = catalog;
  }
  return resources;
}

export const i18n = createInstance();
const initialLocale = detectLocale();
void i18n.use(initReactI18next).init({
  resources: catalogResources(),
  lng: initialLocale,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: [...LOCALES],
  load: "currentOnly",
  defaultNS: "settings",
  ns: [...NAMESPACES],
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  initAsync: false,
});

/**
 * Keeps the document in step with the active locale: `<html lang>`/`dir` for
 * hyphenation, screen readers and the right-to-left (Arabic) layout, plus the
 * browser tab title, which is product metadata rather than a shell string.
 */
function applyDocumentLocale(locale: Locale): void {
  applyDocumentDirection(locale);
  if (typeof document === "undefined") return;
  const common = i18n.getFixedT(locale, "common");
  document.title = common("appTitle");
}

i18n.on("languageChanged", (language) => {
  applyDocumentLocale(normalizeLocale(language) ?? DEFAULT_LOCALE);
});
applyDocumentLocale(initialLocale);

/**
 * Applies an explicit language choice. The choice is remembered in this browser so
 * it wins over the browser's language on the next visit; the server settings have
 * no language field, so there is nothing to save there.
 */
export async function setLocale(locale: Locale): Promise<void> {
  await i18n.changeLanguage(locale);
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* Switching still works without storage. */
  }
}

export { isRtlLocale };