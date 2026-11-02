import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  fetchTokenHistory: () =>
    Promise.resolve({ day: [], hour: [], firstDay: null, firstHour: null, retention: { days: 35, hours: 840 } }),
  resetTokenTotals: () => Promise.resolve({ removed: 0 }),
}));
vi.mock("../../api/llmTokenClient", () => ({
  fetchLlmTokenTotals: () => Promise.resolve({ series: [] }),
  fetchLlmTokenCost: () => new Promise(() => {}),
}));

import { TokensPage } from "./TokensPage";
import { setLocale } from "../../i18n";
import { flush, render } from "../../testing/render";

beforeEach(async () => {
  localStorage.clear();
  await setLocale("zh-CN");
});
afterEach(async () => {
  await act(() => setLocale("en"));
  localStorage.clear();
});

it("renders the page copy from the active catalog and follows a language switch", async () => {
  const { container } = render(<TokensPage sparks={[]} />);
  await flush();
  expect(container.querySelector("h1")?.textContent).toBe("Token 总量");
  expect(container.textContent).toContain("近 24 小时");
  expect(container.textContent).toContain("今天没有 token 流量。");
  expect(container.textContent).not.toContain("No token traffic");

  await act(async () => {
    await setLocale("ar");
  });
  await flush();
  expect(document.documentElement.dir).toBe("rtl");
  expect(container.querySelector("h1")?.textContent).toBe("إجمالي الرموز");
  expect(container.textContent).toContain("آخر 24 ساعة");
});