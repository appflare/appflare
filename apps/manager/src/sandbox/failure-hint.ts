/**
 * Whether the Settings card names a failed sandbox job. When enabling,
 * updating or disabling sandbox builds fails, the card would otherwise only
 * show its state ("Off", for a first enable that stopped part way), with no
 * sign that anything was tried. So the card shows the most recent failed
 * enable, update or disable job until a newer one succeeds. A job still
 * queued or running decides neither way: the card shows it as running
 * instead. Client-safe (no bindings).
 */

export interface SandboxJobOutcome {
  id: string;
  kind: string;
  status: string;
}

/**
 * The failed job the card names, from the sandbox Worker's enable, update
 * and disable jobs ordered newest first; null when the newest finished one
 * succeeded, or none has finished.
 */
export function lastSandboxFailure<T extends SandboxJobOutcome>(
  newestFirst: readonly T[],
): T | null {
  for (const job of newestFirst) {
    if (job.status === "succeeded") return null;
    if (job.status === "failed") return job;
  }
  return null;
}

/** The first non-empty line of a log message or error, trimmed; null when there is none. */
export function firstLine(text: string | null | undefined): string | null {
  const line = text
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? null;
}
