import { sinceDay } from "../catalog/storefront";
import type { AppSignal } from "./attention";

/**
 * The one quiet line under an app's name on its Home card: what state it is
 * in, in words ("Running · 0.3.0 · updated 3 days ago", "Update available",
 * "Not responding"). Client-safe.
 */
export function appLine(
  app: { status: string; version: string; updatedAt: string },
  /** The app's most severe "Needs attention" row, if any (`appSignals`). */
  signal: AppSignal | undefined,
  now: Date,
): string {
  switch (app.status) {
    case "installing":
      return "Installing";
    case "updating":
      return "Updating";
    case "failed":
      return "Install did not finish";
    case "uninstalling":
      return signal === "failed" ? "Removal did not finish" : "Being removed";
  }
  if (signal === "not-responding") return "Not responding";
  if (signal === "failed") return "Last change did not finish";
  if (signal === "update") return "Update available";
  return `Running · ${app.version} · updated ${sinceDay(app.updatedAt, now)}`;
}
