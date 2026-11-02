import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  fetchTokenHistory: vi.fn(async () => ({ hour: [], day: [] })),
}));
vi.mock("../../api/llmTokenClient", () => ({ fetchLlmTokenTotals: vi.fn(async () => ({ series: [] })) }));
vi.mock("../../api/costClient", () => ({
  fetchModelPrices: vi.fn(async () => ({
    source: "fixture",
    models: [
      {
        id: "hosted-model",
        provider: "test",
        mode: "chat",
        inputCostPerToken: 0.0000003,
        outputCostPerToken: 0.0000125,
        cacheReadCostPerToken: null,
        cacheWriteCostPerToken: null,
        maxInputTokens: null,
        maxOutputTokens: null,
      },
    ],
  })),
}));

import { CostPage } from "./CostPage";
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

it("renders the cost copy from the active catalog and follows a language switch", async () => {
  const { container } = render(<CostPage />);
  await flush();
  expect(container.querySelector("h1")?.textContent).toBe("费用对比");
  expect(container.textContent).toContain("计价模型");
  expect(container.textContent).toContain("选择托管模型…");
  expect(container.textContent).not.toContain("Priced as");

  await act(async () => {
    await setLocale("ar");
  });
  await flush();
  expect(document.documentElement.dir).toBe("rtl");
  expect(container.querySelector("h1")?.textContent).toBe("مقارنة التكاليف");
  expect(container.textContent).toContain("اختر نموذجًا مستضافًا…");
});