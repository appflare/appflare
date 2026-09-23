import type { BuildStage } from "@appflare/schema";
import { parseBuildProgress, type SandboxBuildsBinding } from "./binding";

/**
 * Live output of a running sandbox build for the job page. The job's own
 * `build in sandbox` step waits on one RPC call until the build ends, so the
 * job log only gets the output then; meanwhile the page asks the sandbox
 * Worker for the build's progress (its log in R2) on each poll. That costs
 * the page's request one call and never touches the job's invocation.
 */

/** Lines of live output the job page shows. */
export const PROGRESS_LINES = 30;

export interface BuildProgressView {
  stage: BuildStage;
  /** ISO 8601 of the last output. */
  updatedAt: string;
  /** The last lines of output, oldest first. */
  lines: string[];
}

/** The build a job waits on, from its recorded input (`sandboxBuild: true`); null for others. */
export function sandboxBuildOfInput(inputJson: string | null): { version: string } | null {
  if (inputJson === null) return null;
  try {
    const input = JSON.parse(inputJson) as { sandboxBuild?: unknown; version?: unknown };
    return input.sandboxBuild === true && typeof input.version === "string"
      ? { version: input.version }
      : null;
  } catch {
    return null;
  }
}

/** The progress of a running build, or null (none, finished, or the sandbox Worker is unreachable). */
export async function readBuildProgress(
  binding: SandboxBuildsBinding | undefined,
  build: { installId: string; version: string },
): Promise<BuildProgressView | null> {
  if (binding === undefined) return null;
  try {
    const progress = parseBuildProgress(await binding.progress(build));
    if (progress === null || progress.state !== "running") return null;
    const lines = progress.log.replace(/\r\n?/g, "\n").split("\n");
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
    return {
      stage: progress.stage,
      updatedAt: progress.updatedAt,
      lines: lines.slice(-PROGRESS_LINES),
    };
  } catch {
    return null;
  }
}
