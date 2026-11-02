// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityPage } from "./ActivityPage";
import { setLocale } from "../../i18n";
import { cleanupRenders, flush, render } from "../../testing/render";

const events = [
  {
    id: 2,
    ts: Date.now() - 60_000,
    type: "gpu.throttle.thermal",
    severity: "warn" as const,
    sparkId: "s1",
    sparkName: "spark-01",
    message: "spark-01 started thermal throttling",
  },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("events")) return json({ events, oldestId: 2 });
    return json({});
  }));
});
afterEach(async () => {
  cleanupRenders();
  vi.unstubAllGlobals();
  await act(async () => setLocale("en"));
});

describe("ActivityPage copy switching", () => {
  it("renders catalog wording in English, German and Arabic", async () => {
    render(<ActivityPage sparks={[]} />);
    await flush();
    expect(document.body.textContent).toContain("Activity");
    expect(document.body.textContent).toContain("Events, 24 h");
    await act(async () => setLocale("de"));
    expect(document.body.textContent).toContain("Aktivität");
    expect(document.body.textContent).toContain("Ereignisse, 24 Std.");
    expect(document.body.textContent).not.toContain("live.");
    await act(async () => setLocale("ar"));
    expect(document.body.textContent).toContain("النشاط");
    expect(document.body.textContent).not.toContain("tiles.");
    expect(document.documentElement.getAttribute("dir")).toBe("rtl");
  });
});