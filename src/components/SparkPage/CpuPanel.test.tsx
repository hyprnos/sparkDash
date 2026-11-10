import { describe, expect, it } from "vitest";
import { CpuPanel } from "./CpuPanel";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

describe("CpuPanel power and topology", () => {
  const spark = makeSpark();
  const cpu = { usage: 0.4, temperature: 56.6, draw: 14.8, tdp: 185 };

  it("labels estimated power and does not present the assumed TDP as measured", () => {
    const { container } = render(
      <CpuPanel cpu={{ ...cpu, powerSource: "estimated" }} hardware={{ ...spark.hardware!, cpuCores: 32 }} sparkId={spark.id} temperatureUnit="celsius" />,
    );
    expect(container.textContent).toContain("0.4%");
    expect(container.textContent).toContain("CPU power · est.");
    expect(container.textContent).toContain("≈14.8W");
    expect(container.textContent).not.toContain("185W");
    expect(container.textContent).toContain("32 logical CPUs");
  });

  it("does not show an invented CPU draw alongside measured SoC power", () => {
    const { container } = render(
      <CpuPanel cpu={{ ...cpu, powerSource: "estimated" }} socPowerAvailable sparkId={spark.id} temperatureUnit="celsius" />,
    );
    expect(container.textContent).toContain("CPU power—");
    expect(container.textContent).not.toContain("14.8W");
  });

  it("retains the value and limit for measured power", () => {
    const { container } = render(
      <CpuPanel cpu={{ ...cpu, powerSource: "measured" }} sparkId={spark.id} temperatureUnit="celsius" />,
    );
    expect(container.textContent).toContain("14.8W / 185W");
    expect(container.textContent).not.toContain("CPU power · est.");
  });
});
