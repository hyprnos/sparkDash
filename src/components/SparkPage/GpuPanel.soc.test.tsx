import { describe, expect, it } from "vitest";
import { GpuPanel } from "./GpuPanel";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

describe("GpuPanel shared package power", () => {
  it("shows measured SoC PPT without calling it GPU-only power", () => {
    const spark = makeSpark();
    const gpu = {
      ...spark.metrics.gpu!,
      usage: 99,
      temperature: 82,
      throttle: null,
      socPowerWatts: 99.5,
      metricAvailability: { usage: true, temperature: true, powerDraw: false, powerLimit: false, vramUsed: false, vramTotal: false },
    };
    const { container } = render(<GpuPanel gpu={gpu} sparkId={spark.id} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("99%");
    expect(container.textContent).toContain("82°C");
    expect(container.textContent).toContain("SoC PPT · CPU + GPU99.5W");
    // AMD APUs report no power limit: the power legend must not claim a line
    // that the chart never plots.
    expect(container.querySelector(".c-violet")).toBeNull();
    expect(container.textContent).not.toContain("Not throttled");
  });
});
