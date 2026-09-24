import { and, eq, inArray, ne } from "drizzle-orm";
import type { Database } from "../db/client";
import { installs, jobs } from "../db/schema";
import { sandboxBuildOfInput } from "./progress";

/**
 * Whether the sandbox Worker is busy. Every secret written to or deleted from
 * `appflare-sandbox` deploys a new version of it, which restarts its Durable
 * Objects and with them every container they run: a build or an installer run
 * in progress would be killed. So nothing stores or deletes a secret there
 * while a job that runs in the sandbox Worker is queued or running, other than
 * the job doing the writing (its own run has not started yet).
 */

export interface SandboxJob {
  id: string;
  kind: string;
  slug: string | null;
}

/** A queued or running job that uses the sandbox Worker, other than `exceptJobId`; null when none. */
export async function activeSandboxJob(
  orm: Database,
  exceptJobId?: string,
): Promise<SandboxJob | null> {
  const rows = await orm
    .select({
      id: jobs.id,
      kind: jobs.kind,
      input: jobs.input_json,
      installId: jobs.install_id,
    })
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, ["queued", "running"]),
        exceptJobId === undefined ? undefined : ne(jobs.id, exceptJobId),
      ),
    );
  const busy = rows.find((row) => usesSandbox(row.input));
  if (busy === undefined) return null;
  let slug: string | null = null;
  if (busy.installId !== null) {
    const [install] = await orm
      .select({ slug: installs.app_slug })
      .from(installs)
      .where(eq(installs.id, busy.installId))
      .limit(1);
    slug = install?.slug ?? null;
  }
  return { id: busy.id, kind: busy.kind, slug };
}

/** Whether a job's recorded input says it runs in the sandbox Worker. */
function usesSandbox(inputJson: string | null): boolean {
  if (sandboxBuildOfInput(inputJson) !== null) return true;
  try {
    const input = JSON.parse(inputJson ?? "null") as { selfDeploying?: unknown } | null;
    return input?.selfDeploying === true;
  } catch {
    return false;
  }
}

/** Why a secret cannot be written to the sandbox Worker now. */
export function sandboxBusyMessage(job: SandboxJob): string {
  return `the sandbox Worker is busy with the ${job.kind.replace("_", "-")} job ${job.id}${job.slug === null ? "" : ` of ${job.slug}`}; changing its secrets now would restart it and stop that run. Wait for that job to finish, then try again`;
}
