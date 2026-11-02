// Text direction for the shipped locales, and the shell's right-to-left rules.
//
// The shell stylesheets (src/styles/*.css) use physical directions: a rail border
// on the right, text aligned left, a tab highlight anchored to `left`. Those live
// outside this module, so the handful of rules that have to mirror for Arabic are
// kept in ./rtl.css next to the locale that needs them. Every rule there is
// `[dir="rtl"]`-scoped, which also gives it the specificity to win over the base
// stylesheet regardless of the bundle's CSS order.
import "./rtl.css";

export type TextDirection = "ltr" | "rtl";

/** Arabic is the only right-to-left locale sparkDash ships, in any region or script form. */
export function isRtlLocale(locale: string | null | undefined): boolean {
  if (!locale) return false;
  return locale.trim().toLowerCase().split(/[-_]/)[0] === "ar";
}

export function directionFor(locale: string | null | undefined): TextDirection {
  return isRtlLocale(locale) ? "rtl" : "ltr";
}

/**
 * Applies the active locale to the document: `<html lang>` for hyphenation, screen
 * readers and spell check, and `<html dir>` so Arabic renders right-to-left. The
 * direction is set explicitly for every locale, so switching away from Arabic
 * restores a left-to-right layout instead of leaving `dir` behind.
 */
export function applyDocumentDirection(locale: string): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.lang = locale;
  root.dir = directionFor(locale);
}