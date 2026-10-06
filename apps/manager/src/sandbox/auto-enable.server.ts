import type { CloudflareClient } from "@appflare/cf-api";
import { probeContainers, probeR2 } from "@appflare/cf-api/capabilities";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AccountPlan } from "../account/plan";
import { messageLink } from "../components/message-links";
import { NO_REMOVAL_IN_PROGRESS_SQL } from "../danger/removal-flag";
import { createDb } from "../db/client";
import { jobs } from "../db/schema";
import { reconcileJobs, type WorkflowLookup } from "../jobs/reconcile.server";
import type { SandboxEnableJobParams } from "./enable-job";
import { SANDBOX_CAPABILITY_HREF, sandboxReadiness } from "./readiness";
import { PINNED_SANDBOX_VERSION } from "./release";

/**
 * Sandbox builds turned on at first need. When an install of an app built
 * in the account (or deployed by its own installer), or a build from a
 * repository, starts while this manager is not connected to the sandbox
 * Worker (no `SANDBOX` binding, or one to a sandbox Worker that was deleted:
 * see sandbox/connection.server.ts), and the account has what sandbox builds
 * need, the start also claims a
 * `sandbox_enable` job, and the install or build job waits for it before
 * its first step that uses the sandbox Worker (jobs/sandbox-enable-wait.ts).
 *
 * Why a job of its own rather than the enable steps inside the install or
 * build job: the enable job ends by deploying a new version of Appflare's
 * own Worker (the one that adds `SANDBOX`), and no step may run after that
 * deploy in the same instance; the waiting job instead sleeps, and is
 * expected to resume on the version that has the binding (an instance cut
 * off by that deploy was seen resuming on the new version; a sleeping one
 * has not been verified live, so the wait checks that the binding answers
 * and gives up with a clear message). Its own instance also keeps the enable's
 * subrequests (about 40) out of the other job's budget, and it is the same
 * job Settings starts, so Settings shows its progress, its failure, and its
 * Disable, and usage data counts it as `sandbox_enable` (with trigger
 * `auto`, from `neededBy` in its recorded input).
 *
 * The enable job is claimed like the one Settings starts: only while no
 * other job is queued or running (uploading the sandbox Worker restarts its
 * containers, and connecting deploys Appflare), and only together with the
 * start's own job row, in one batch. A start while an enable job is queued
 * or running, or one that loses the claim to another start turning sandbox
 * builds on, waits for that job.
 */

export class SandboxAutoEnableError extends Error {
  override name = "SandboxAutoEnableError";
}

/** Where a refusal sends the admin. */
export const SANDBOX_CAPABILITY_POINTER = `See ${messageLink("Sandbox builds in Your account", SANDBOX_CAPABILITY_HREF)}.`;

const BUSY =
  "Sandbox builds are off, and Appflare turns them on first only while no other job is queued or running. Wait for it to finish, then try again.";

const CHANGING =
  "Sandbox builds are being updated or disabled now. Wait for that job to finish, then try again.";

/** The job that turns sandbox builds on for another, as its recorded input names it. */
export interface NeededBy {
  jobId: string;
  kind: "install" | "source_build";
}

export interface SandboxAutoEnableDeps {
  /** For the two live probes (R2, Containers); built only when the sandbox is off. */
  client(): Promise<CloudflareClient>;
  /** Why the sandbox Worker release `version` cannot be read, or null (see `sandboxReleaseProblem`). */
  releaseProblem(version: string): Promise<string | null>;
  /** Creates the enable job's Workflow instance. */
  createJob(id: string, params: SandboxEnableJobParams): Promise<{ id: string }>;
  /** The running Appflare version (`runningVersion`). */
  currentVersion: string;
  /** The sandbox Worker release to deploy; the manager's pin. */
  sandboxVersion?: string;
}

/** What a start that needs the sandbox does about it, when this manager is not connected. */
export type SandboxFirst =
  /** An enable job is already queued or running: wait for that one. */
  | { kind: "join"; enableJobId: string }
  /** Claim a new enable job in the start's own batch, then create it. */
  | {
      kind: "enable";
      enableJobId: string;
      params: SandboxEnableJobParams;
      inputJson: string;
    };

/**
 * Decides, for a start that needs the sandbox while it is off: wait for an
 * enable job already running, or turn it on first. Throws
 * `SandboxAutoEnableError` naming exactly what is missing (from live
 * probes: Workers Paid, R2, the token's Containers: Edit; and the release).
 */
export async function planSandboxFirst(
  db: D1Database,
  deps: SandboxAutoEnableDeps,
  opts: {
    /** The Workers plan in force (stored); Containers available overrides it. */
    plan: AccountPlan;
    neededBy: NeededBy;
    newId: () => string;
    workflows?: WorkflowLookup;
  },
): Promise<SandboxFirst> {
  const orm = createDb(db);
  const readActive = () =>
    orm
      .select()
      .from(jobs)
      .where(
        and(
          inArray(jobs.kind, ["sandbox_enable", "sandbox_update", "sandbox_disable"]),
          inArray(jobs.status, ["queued", "running"]),
        ),
      );
  let active = await readActive();
  if (active.length > 0 && opts.workflows !== undefined) {
    if (await reconcileJobs(db, opts.workflows, active)) active = await readActive();
  }
  const enabling = active.find((j) => j.kind === "sandbox_enable");
  if (enabling !== undefined) return { kind: "join", enableJobId: enabling.id };
  if (active.length > 0) throw new SandboxAutoEnableError(CHANGING);

  const client = await deps.client();
  const [r2, containers] = await Promise.all([probeR2(client), probeContainers(client)]);
  const readiness = sandboxReadiness({
    connected: false,
    r2,
    containers,
    plan: opts.plan,
    accountId: client.accountId,
  });
  if (readiness.missing !== null) {
    throw new SandboxAutoEnableError(
      `Sandbox builds are off, and Appflare cannot turn them on: ${readiness.missing} ${SANDBOX_CAPABILITY_POINTER}`,
    );
  }
  const version = deps.sandboxVersion ?? PINNED_SANDBOX_VERSION;
  const releaseProblem = await deps.releaseProblem(version);
  if (releaseProblem !== null) {
    throw new SandboxAutoEnableError(
      `Sandbox builds are off, and Appflare cannot turn them on: ${releaseProblem} ${SANDBOX_CAPABILITY_POINTER}`,
    );
  }
  const enableJobId = opts.newId();
  return {
    kind: "enable",
    enableJobId,
    params: {
      kind: "sandbox_enable",
      jobId: enableJobId,
      version,
      managerVersion: deps.currentVersion,
      neededBy: opts.neededBy,
    },
    // What the job list and usage data read: the release it deploys, none it
    // replaces, and the job it runs for.
    inputJson: JSON.stringify({ version, fromVersion: null, neededBy: opts.neededBy }),
  };
}

/**
 * The claim of a new enable job, the last statement of the start's own D1
 * batch: inserted only when the start's job row (`dependentJobId`) was, so a
 * refused start never leaves an enable job behind. The start's first row
 * carries `sandboxFirstGuardSql`, which for a new enable job requires that
 * no job at all is queued or running, as Settings claims it.
 */
export function sandboxEnableClaim(
  db: D1Database,
  first: Extract<SandboxFirst, { kind: "enable" }>,
  dependentJobId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, started_by)
       SELECT ?1, NULL, 'sandbox_enable', 'queued', ?2, 'admin'
       WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ?3)`,
    )
    .bind(first.enableJobId, first.inputJson, dependentJobId);
}

/**
 * SQL condition for the first row a start inserts, with `param` bound to
 * `first?.enableJobId ?? null`: with the sandbox on, nothing more; waiting
 * for a running enable job, that job exists; claiming a new one, no job at
 * all is queued or running (checked before the start's own job row exists).
 */
export function sandboxFirstGuardSql(first: SandboxFirst | null, param: string): string {
  if (first === null) return `(${param} IS NULL)`;
  if (first.kind === "join") {
    return `EXISTS (SELECT 1 FROM jobs WHERE id = ${param} AND kind = 'sandbox_enable')`;
  }
  return `(${param} IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM jobs WHERE status IN ('queued', 'running'))
    AND ${NO_REMOVAL_IN_PROGRESS_SQL})`;
}

/**
 * After a start's batch claimed nothing: removes this start's enable row if
 * one is somehow there without a Workflow instance, then says what to do. A
 * start that meant to turn sandbox builds on and lost to another start doing
 * the same waits for that one instead (the `join` to retry the batch with);
 * one that lost to any other job is refused with a message. Null: the
 * refusal has nothing to do with the sandbox, and the start explains it.
 */
export async function afterRefusedClaim(
  db: D1Database,
  first: SandboxFirst | null,
): Promise<Extract<SandboxFirst, { kind: "join" }> | { refused: string } | null> {
  if (first?.kind !== "enable") return null;
  const orm = createDb(db);
  await orm
    .delete(jobs)
    .where(
      and(
        eq(jobs.id, first.enableJobId),
        eq(jobs.status, "queued"),
        isNull(jobs.workflow_instance_id),
      ),
    );
  const active = await orm
    .select({ id: jobs.id, kind: jobs.kind })
    .from(jobs)
    .where(inArray(jobs.status, ["queued", "running"]));
  const enabling = active.find((j) => j.kind === "sandbox_enable");
  if (enabling !== undefined) return { kind: "join", enableJobId: enabling.id };
  return active.length > 0 ? { refused: BUSY } : null;
}

/**
 * Creates the claimed enable job's Workflow instance. On failure the job is
 * recorded as failed (the waiting job then fails with its reason) and the
 * error is thrown for the start to report.
 */
export async function launchSandboxEnable(
  db: D1Database,
  deps: Pick<SandboxAutoEnableDeps, "createJob">,
  first: SandboxFirst | null,
  now: Date,
): Promise<void> {
  if (first?.kind !== "enable") return;
  const orm = createDb(db);
  let instanceId: string;
  try {
    instanceId = (await deps.createJob(first.enableJobId, first.params)).id;
  } catch (error) {
    const reason = `start: could not create the job: ${error instanceof Error ? error.message : String(error)}`;
    await orm
      .update(jobs)
      .set({ status: "failed", error: reason, finished_at: now })
      .where(eq(jobs.id, first.enableJobId));
    throw new SandboxAutoEnableError(`Could not turn sandbox builds on: ${reason}`);
  }
  await orm
    .update(jobs)
    .set({ workflow_instance_id: instanceId })
    .where(eq(jobs.id, first.enableJobId));
}
