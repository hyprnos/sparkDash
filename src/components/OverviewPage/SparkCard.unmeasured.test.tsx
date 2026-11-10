import { describe, expect, it, vi } from "vitest";
import { SparkCard } from "./SparkCard";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

vi.mock("../../api/client", () => ({
  fetchLaunchers: () => new Promise(() => {}),
  runLauncher: vi.fn(),
  wakeSpark: vi.fn(),
}));

function withLlm(overrides: Record<string, unknown>) {
  const spark = makeSpark();
  Object.assign(spark.metrics.llm[0], { available: true, ...overrides });
  return spark;
}

describe("SparkCard when the engine's stats could not be read", () => {
  it("shows no rate instead of 0.0 tok/s, and says why on hover", () => {
    const { container } = render(
      <SparkCard
        spark={withLlm({ measurementValid: false, measurementError: "stats endpoint answered 500", generationTps: 0, prefillTps: 0 })}
        temperatureUnit="celsius"
      />,
    );
    expect(container.textContent).toMatch(/Decode—/);
    expect(container.textContent).toMatch(/Prefill—/);
    expect(container.textContent).not.toMatch(/Decode0\.0tok\/s/);
    expect(container.querySelector('[title*="answered 500"]')).not.toBeNull();
  });

  it("labels estimated CPU power without presenting the assumed limit", () => {
    const spark = withLlm({});
    Object.assign(spark.metrics.cpu!, { draw: 14.8, tdp: 185, powerSource: "estimated" });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("CPU power · est.");
    expect(container.textContent).toContain("≈14.8 W");
    expect(container.textContent).not.toContain("185 W");
  });

  it("shows SoC power separately from unavailable GPU and CPU power", () => {
    const spark = withLlm({});
    Object.assign(spark.metrics.cpu!, { draw: 20, tdp: 185, powerSource: "estimated" });
    Object.assign(spark.metrics.gpu!, { socPowerWatts: 99.5, metricAvailability: { usage: true, temperature: true, powerDraw: false, powerLimit: false, vramUsed: false, vramTotal: false } });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("SoC PPT · CPU + GPU99.5 W");
    expect(container.textContent).not.toContain("CPU power · est.");
    expect(container.textContent).not.toContain("GPU power99.5");
  });

  it("still shows a readable idle engine as 0.0 tok/s", () => {
    const { container } = render(
      <SparkCard spark={withLlm({ measurementValid: true, generationTps: 0, prefillTps: 0 })} temperatureUnit="celsius" />,
    );
    expect(container.textContent).toMatch(/Decode0\.0tok\/s/);
  });
});
