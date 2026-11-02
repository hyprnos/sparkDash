import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const config = {
  enabled: true,
  device: { name: "NRF_EPD_A568", address: "AA:BB" },
  intervalMinutes: 30,
  sections: { headline: true, stats: true, rows: true, cost: false },
  pigment: "yellow",
  theme: "dark",
  backgroundZoom: 1,
  backgroundOffsetX: 0,
  backgroundOffsetY: 0,
  backgroundBrightness: 0,
  backgroundContrast: 0,
  ditherAlgorithm: "floyd-steinberg",
  ditherStrength: 0.5,
  title: "sparkDash",
  footer: "",
  textProtection: "auto",
  haloWidth: 2,
  background: null,
};

vi.mock("./einkClient", () => ({
  fetchEinkConfig: () => Promise.resolve({ config, status: { bridgeUrl: "http://bridge" } }),
  fetchEinkAlgorithms: () => Promise.resolve(["floyd-steinberg"]),
  fetchEinkDevices: () => Promise.resolve([]),
  fetchEinkPreview: () => Promise.resolve(null),
  pushEinkNow: () => Promise.resolve({ status: {}, durationMs: 1000 }),
  saveEinkConfig: () => Promise.resolve({ config, status: {} }),
  uploadEinkBackground: () => Promise.resolve({ config, status: {} }),
  clearEinkBackground: () => Promise.resolve(),
}));

import { EinkPage } from "./EinkPage";
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

it("translates every panel and follows a language switch", async () => {
  const { container } = render(<EinkPage />);
  await flush();
  expect(container.querySelector("h1")?.textContent).toBe("墨水屏");
  expect(container.textContent).toContain("刷新节奏");
  expect(container.textContent).toContain("显示内容");
  expect(container.querySelectorAll("select option").length).toBeGreaterThan(3);

  await act(async () => {
    await setLocale("ja");
  });
  await flush();
  expect(container.querySelector("h1")?.textContent).toBe("電子ペーパー");
  expect(container.textContent).toContain("更新間隔");
  expect(container.textContent).not.toContain("刷新节奏");
});