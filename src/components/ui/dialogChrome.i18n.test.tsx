import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { render } from "../../testing/render";
import { ConfirmShutdownDialog } from "../ConfirmShutdownDialog";
import { i18n } from "../../i18n";

/** Put the shared instance back on the source language for the next case. */
afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage("en");
  });
});

describe("shared dialog copy", () => {
  it("renders the typed confirmation phrase as markup and the chrome from the catalog", () => {
    render(
      <ConfirmShutdownDialog open onClose={() => {}} onConfirm={() => {}} title="Power off spark-1" description="Stops the host." />,
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Danger zone — Power off spark-1");
    expect(dialog.querySelector("label b.mono")?.textContent).toBe("poweroff");
    expect(dialog.textContent).toContain("Type");
    expect(dialog.textContent).toContain("to confirm");
    expect(dialog.textContent).toContain("Cancel");
  });

  it("follows the active locale", async () => {
    await act(async () => {
      await i18n.changeLanguage("ja");
    });
    render(
      <ConfirmShutdownDialog open onClose={() => {}} onConfirm={() => {}} title="spark-1" description="止まります。" />,
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("危険な操作 — spark-1");
    expect(dialog.textContent).toContain("キャンセル");
  });
});
