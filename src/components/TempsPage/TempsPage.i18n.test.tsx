import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  getGpuHistory: vi.fn(async () => ({ t: [], u: [], c: [], p: [] })),
}));

import { TempsPage } from "./TempsPage";
import { setLocale } from "../../i18n";
import { flush, render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";

beforeEach(async () => {
  localStorage.clear();
  await setLocale("zh-CN");
});
afterEach(async () => {
  await act(() => setLocale("en"));
  localStorage.clear();
});

it("renders the temperature copy from the active catalog and follows a language switch", async () => {
  const { container } = render(<TempsPage sparks={[makeSpark("a")]} />);
  await flush();
  expect(container.querySelector("h1")?.textContent).toBe("温度");
  expect(container.textContent).toContain("预热中");
  expect(container.textContent).not.toContain("Warming up");

  await act(async () => {
    await setLocale("ar");
  });
  await flush();
  expect(document.documentElement.dir).toBe("rtl");
  expect(container.querySelector("h1")?.textContent).toBe("درجات الحرارة");
  expect(container.textContent).toContain("قيد التسخين");
});