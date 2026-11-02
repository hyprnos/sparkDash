// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HistoryTable } from "./sparkdash/pageParts";
import { SparkChips } from "./SparkChips";
import type { HistoryRow } from "./sparkdash/historyRows";
import type { SparkSnapshot } from "../../api/types";
import { setLocale } from "../../i18n";
import { cleanupRenders, flush, render } from "../../testing/render";

const spark = {
  id: "s1",
  name: "spark-01",
  online: true,
  workerNode: true,
  metrics: { llm: [] },
} as unknown as SparkSnapshot;

const rows: HistoryRow[] = [
  { id: "b1", startedAt: Date.UTC(2026, 9, 7, 10, 0), status: "completed", label: "×1, 4", model: "qwen", headline: "90.0 tok/s", detail: "peak at ×4" },
];

beforeEach(() => {
  localStorage.clear();
});
afterEach(async () => {
  cleanupRenders();
  await act(async () => setLocale("en"));
});

describe("bench catalog in the shared bench chrome", () => {
  it("translates the spark picker, history table and worker tag", async () => {
    render(
      <div>
        <SparkChips sparks={[spark]} activeId="s1" onSelect={() => {}} />
        <HistoryTable rows={rows} activeId={null} labelHeader="Run" onView={() => {}} busy={false} />
      </div>
    );
    await flush();
    expect(document.body.textContent).toContain("worker");
    expect(document.body.textContent).toContain("View");

    await act(async () => setLocale("ar"));
    expect(document.body.textContent).toContain("عاملة");
    expect(document.body.textContent).toContain("التاريخ");
    expect(document.body.textContent).toContain("عرض");
  });
});