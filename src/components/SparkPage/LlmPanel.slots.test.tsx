import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { LlmPanel } from "./LlmPanel";

vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));

describe("TensorFold slot tile", () => {
  it.each([null, 0, 8])("renders occupancy %s with known capacity", (active) => {
    const llm = { ...makeSpark().metrics.llm[0], backend: "tensorfold" as const, slotsActive: active, slotsTotal: 8 };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
    const tile = [...container.querySelectorAll(".sp-tile")].find((el) => el.querySelector("span")?.textContent === "Slots");
    expect(tile?.querySelector("b")?.textContent).toBe(`${active ?? "?"} / 8`);
  });
});

describe("Radiance engine tiles", () => {
  it("shows the vLLM-format KV cache tile", () => {
    const llm = { ...makeSpark().metrics.llm[0], backend: "radiance" as const, kvCacheUsage: 0.25, kvCacheTokens: 1_087_768, ttftP95Seconds: 0.4 };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
    const labels = [...container.querySelectorAll(".sp-tile")].map((el) => el.querySelector("span")?.textContent);
    expect(labels).toContain("KV cache");
    expect(labels).toContain("TTFT p95");
  });
});

describe("native SGLang telemetry", () => {
  it("shows prefill outside running/waiting queues, KV pressure and backlog", () => {
    const llm = { ...makeSpark().metrics.llm[0], backend: "sglang" as const,
      metricsSource: "sglang-loads" as const, runtimePhase: "prefill" as const,
      prefillActive: true, prefillTps: 4096, generationTps: 0,
      pendingPrefillTokens: 500000, requestsRunning: 0, requestsWaiting: 2,
      kvCacheTokens: 6122752, kvCacheTokensUsed: 100000, kvCacheUsage: .8,
      kvCacheTokensAvailable: null, cachedPrefillTps: null, uncachedPrefillTps: 4096 };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Prefilling");
    expect(text).toContain("Prefill backlog (est.)");
    expect(text).toContain("KV pressure");
    expect(text).toContain("80%");
    expect(text).toContain("0 / 2");
    expect(text).not.toContain("Cached prefill");
    expect(container.querySelector("[data-llm-idle]")).toBeNull();
  });

  it("renders stale rates as unknown rather than zero or idle", () => {
    const llm = { ...makeSpark().metrics.llm[0], backend: "sglang" as const,
      metricsSource: "sglang-loads" as const, runtimePhase: "stale" as const,
      prefillTps: 0, generationTps: 0, prefillTpsKnown: false, generationTpsKnown: false };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} />);
    expect(container.textContent).toContain("Stale");
    expect(container.textContent).toMatch(/Decode—/);
    expect(container.textContent).toMatch(/Prefill—tok\/s/);
    expect(container.querySelector("[data-llm-idle]")).toBeNull();
  });
});
