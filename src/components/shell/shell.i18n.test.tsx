import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageSelector } from "../LanguageSelector";
import { AppSidebar } from "./AppSidebar";
import { MobileTabBar } from "./MobileTabBar";
import { detectLocale, i18n, LOCALE_STORAGE_KEY, setLocale } from "../../i18n";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

const languageButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] button')].find(
    (button) => button.textContent === label,
  )!;

const overviewLabel = (container: HTMLElement) =>
  container.querySelector('a[href="/"] .rail-item__name')?.textContent;

const tabLabels = (container: HTMLElement) =>
  [...container.querySelectorAll(".tabbar button")].map((button) => button.textContent);

function Shell() {
  return (
    <>
      <LanguageSelector />
      <AppSidebar
        sparks={[makeSpark("a")]}
        activeId={null}
        onSelect={() => {}}
        onAdd={() => {}}
        onOpenSettings={() => {}}
        onOpenSearch={() => {}}
        connected
      />
      <MobileTabBar sparks={[makeSpark("a")]} activeId={null} onSelect={() => {}} onAdd={() => {}} onOpenSettings={() => {}} />
    </>
  );
}

beforeEach(async () => {
  localStorage.clear();
  await act(() => setLocale("en"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(() => setLocale("en"));
  localStorage.clear();
});

describe("language picker", () => {
  it("changes the rendered shell labels, including the mobile tab bar", async () => {
    const { container } = render(<Shell />);
    expect(overviewLabel(container)).toBe("Overview");
    expect(tabLabels(container)).toContain("Settings");

    await act(async () => languageButton("日本語").click());
    expect(i18n.resolvedLanguage).toBe("ja");
    expect(overviewLabel(container)).toBe("概要");
    expect(tabLabels(container)).toContain("設定");
    expect(document.documentElement.lang).toBe("ja");
    expect(document.documentElement.dir).toBe("ltr");

    await act(async () => languageButton("简体中文").click());
    expect(overviewLabel(container)).toBe("总览");
    expect(document.title).toBe("sparkDash — 多 DGX Spark 监控仪表盘");

    await act(async () => languageButton("English").click());
    expect(overviewLabel(container)).toBe("Overview");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
  });

  it("renders Arabic right-to-left and restores the layout when another language is picked", async () => {
    const { container } = render(<Shell />);
    await act(async () => languageButton("العربية").click());
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
    expect(overviewLabel(container)).toBe("نظرة عامة");
    expect(container.querySelector(".tabbar")?.getAttribute("aria-label")).toBe("التنقّل الرئيسي");

    await act(async () => languageButton("English").click());
    expect(document.documentElement.dir).toBe("ltr");
    expect(overviewLabel(container)).toBe("Overview");
  });

  it("remembers the picked language for the next visit", async () => {
    render(<Shell />);
    await act(async () => languageButton("Deutsch").click());
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("de");
    expect(detectLocale()).toBe("de");
  });
});

describe("system language detection", () => {
  it("follows a supported browser language on a first visit", () => {
    localStorage.clear();
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["ja-JP", "en-US"]);
    vi.spyOn(navigator, "language", "get").mockReturnValue("ja-JP");
    expect(detectLocale()).toBe("ja");
  });

  it("falls back to English for an unknown system language", () => {
    localStorage.clear();
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["xx-YY", "zz-ZZ"]);
    vi.spyOn(navigator, "language", "get").mockReturnValue("xx-YY");
    expect(detectLocale()).toBe("en");
  });
});