import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const NOW = Date.UTC(2026, 9, 16, 12);

vi.mock("../../api/client", () => ({
  fetchEnergyHistory: vi.fn(async () => ({
    estimated: true,
    membershipChanged: false,
    generatedAt: NOW,
    retentionMs: 31 * 86_400_000,
    nodeIds: [],
    hourly: [],
  })),
  fetchFleetEnergy: vi.fn(async () => ({
    estimated: true,
    membershipChanged: false,
    restartRequired: false,
    trackedNodeIds: [],
    currentNodeIds: [],
    freshNodeCount: 0,
    currentWatts30s: null,
    energy24hKwh: null,
    energy31dKwh: null,
    whPerOutputToken24h: null,
  })),
  clearFleetEnergy: vi.fn(async () => ({ removed: 0 })),
  fetchMonthlyEnergy: vi.fn(async () => ({ estimated: true, generatedAt: NOW, foldedThroughMs: NOW, months: [] })),
  fetchRestartAvailable: vi.fn(async () => ({ available: false })),
}));

import { EnergyPage } from "./EnergyPage";
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

it("renders the energy copy from the active catalog and follows a language switch", async () => {
  const { container } = render(<EnergyPage sparks={[]} settings={null} />);
  await flush();
  expect(container.querySelector("h1")?.textContent).toBe("舰队能耗");
  expect(container.textContent).toContain("预热中");
  expect(container.textContent).toContain("月度历史");
  expect(container.textContent).not.toContain("Warming up");

  await act(async () => {
    await setLocale("ar");
  });
  await flush();
  expect(document.documentElement.dir).toBe("rtl");
  expect(container.querySelector("h1")?.textContent).toBe("طاقة الأسطول");
  expect(container.textContent).toContain("السجل الشهري");
});