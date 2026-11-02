import type { ToolEvalRunStatus } from "../../../api/types";
import type { Translate } from "./format";

export type StatusTone = "good" | "bad" | "warn" | "acc" | "neutral";

export function statusTone(status: ToolEvalRunStatus): StatusTone {
  switch (status) {
    case "completed":
      return "good";
    case "failed":
      return "bad";
    case "stopped":
    case "gone":
      return "warn";
    case "running":
      return "acc";
    default:
      return "neutral";
  }
}

export function statusLabel(status: ToolEvalRunStatus, watching = true, t?: Translate): string {
  switch (status) {
    case "running":
      if (t) return watching ? t("te.status.running") : t("te.status.runningUnwatched");
      return watching ? "Running" : "Running (not watched)";
    case "completed":
      return t ? t("te.status.completed") : "Completed";
    case "failed":
      return t ? t("te.status.failed") : "Failed";
    case "stopped":
      return t ? t("te.status.stopped") : "Stopped";
    case "gone":
      return t ? t("te.status.gone") : "Gone";
    default:
      return status;
  }
}
