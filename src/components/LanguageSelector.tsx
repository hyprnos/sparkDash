import { useTranslation } from "react-i18next";
import { i18n, setLocale, type Locale } from "../i18n";
import { SettingRow } from "./SettingRows";

/**
 * Language picker. Every shipped catalog is offered by its own endonym, so people
 * can find their language even when the dashboard is showing one they do not read.
 * The segmented control wraps (`.settings-panel .seg`) for the longer names.
 */
export function LanguageSelector() {
  const { t } = useTranslation("language");
  const locale = i18n.resolvedLanguage;
  const pick = (target: Locale, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={locale === target}
      className={locale === target ? "is-on" : ""}
      lang={target}
      dir={target === "ar" ? "rtl" : undefined}
      onClick={() => void setLocale(target)}
    >
      {label}
    </button>
  );
  return (
    <SettingRow title={t("title")} help={t("help")}>
      <div className="seg" role="radiogroup" aria-label={t("title")}>
        {pick("en", t("english"))}
        {pick("zh-CN", t("simplifiedChinese"))}
        {pick("zh-TW", t("traditionalChinese"))}
        {pick("ja", t("japanese"))}
        {pick("ko", t("korean"))}
        {pick("es", t("spanish"))}
        {pick("fr", t("french"))}
        {pick("de", t("german"))}
        {pick("pt-BR", t("portugueseBrazil"))}
        {pick("ru", t("russian"))}
        {pick("it", t("italian"))}
        {pick("ar", t("arabic"))}
      </div>
    </SettingRow>
  );
}