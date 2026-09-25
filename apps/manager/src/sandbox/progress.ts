import type { RunStep } from "@appflare/schema";
import { parseBuildProgress, type SandboxBuildsBinding } from "./binding";

/**
 * Live output of a running sandbox build (or self-deploying installer run)
 * for the job page. The job's own `build in sandbox` (or `deploy in sandbox`,
 * `destroy in sandbox`) step waits on one RPC call until the run ends, so the
 * job log only gets the output then; meanwhile the page asks the sandbox
 * Worker for the run's progress (its log in R2) on each poll. That costs
 * the page's request one call and never touches the job's invocation.
 */

/** Lines of live output the job page shows. */
export const PROGRESS_LINES = 30;

export interface BuildProgressView {
  /** A build of the app, or a run of its own installer. */
  kind: RunKind;
  stage: RunStep;
  /** ISO 8601 of the last output. */
  updatedAt: string;
  /** The last lines of output, oldest first. */
  lines: string[];
}

export type RunKind = "build" | "installer";

/**
 * The run a job waits on, from its recorded input: a build (`sandboxBuild:
 * true`, logged under the version), an installer run (`sandboxRun`, the run
 * id it is logged under), or a build from a repository (`sandboxRun` with
 * `runKind: "build"`, whose install may not exist yet: `buildInstallId`);
 * null for others.
 */
export function sandboxBuildOfInput(
  inputJson: string | null,
): { version: string; kind: RunKind; installId?: string } | null {
  if (inputJson === null) return null;
  try {
    const input = JSON.parse(inputJson) as {
      sandboxBuild?: unknown;
      sandboxRun?: unknown;
      runKind?: unknown;
      buildInstallId?: unknown;
      version?: unknown;
    };
    if (typeof input.sandboxRun === "string") {
      return {
        version: input.sandboxRun,
        kind: input.runKind === "build" ? "build" : "installer",
        ...(typeof input.buildInstallId === "string" ? { installId: input.buildInstallId } : {}),
      };
    }
    return input.sandboxBuild === true && typeof input.version === "string"
      ? { version: input.version, kind: "build" }
      : null;
  } catch {
    return null;
  }
}

/** The progress of a running build, or null (none, finished, or the sandbox Worker is unreachable). */
export async function readBuildProgress(
  binding: SandboxBuildsBinding | undefined,
  build: { installId: string; version: string; kind?: RunKind },
): Promise<BuildProgressView | null> {
  if (binding === undefined) return null;
  try {
    const progress = parseBuildProgress(
      await binding.progress({ installId: build.installId, version: build.version }),
    );
    if (progress === null || progress.state !== "running") return null;
    const lines = progress.log.replace(/\r\n?/g, "\n").split("\n");
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
    return {
      kind: build.kind ?? "build",
      stage: progress.stage,
      updatedAt: progress.updatedAt,
      lines: lines.slice(-PROGRESS_LINES),
    };
  } catch {
    return null;
  }
}
