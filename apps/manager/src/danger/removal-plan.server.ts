import { CloudflareApiError, type CloudflareClient, R2_NOT_ENABLED_CODE } from "@appflare/cf-api";
import { SANDBOX_BUCKET_BINDING, SANDBOX_BUCKET_NAME, SANDBOX_WORKER_NAME } from "@appflare/schema";
import { and, asc, count, eq, inArray, isNull, ne } from "drizzle-orm";
import { readAccessConfig } from "../access/config";
import { createDb } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { type GatewayState, readGateway } from "../gateway/gateway.server";
import { installLabel } from "../installs/display-name";
import { CUSTOM_DOMAIN_KIND, CUSTOM_HOSTNAME_KIND } from "../installs/resource-kinds";
import { reconcileJobs, type WorkflowLookup } from "../jobs/reconcile.server";
import { domainsTabPath } from "./danger";
import { DangerError } from "./errors";

/**
 * What "Remove Appflare from this account" deletes, read fresh from the
 * account before the review dialog opens and again before the removal runs:
 * the manager Worker with the D1 database and KV namespace it binds, the
 * external domains gateway as its setting records it, the sandbox Worker and
 * its build bucket, and the Cloudflare Access applications that protect the
 * manager. Four read calls: the account, the manager's bindings, the sandbox
 * Worker's bindings, and one page of the bucket list.
 */

export interface ManagerTargets {
  workerName: string;
  /** The D1 database bound as `DB`; null when the Worker binds none. */
  d1Id: string | null;
  /** The KV namespace bound as `KV`; null when the Worker binds none. */
  kvId: string | null;
  /**
   * The Workflow the Worker runs as `JOBS`; null when it binds none, or binds
   * one that another Worker runs. Deleting the Worker leaves it in place.
   */
  workflowName: string | null;
}

export interface SandboxTargets {
  /**
   * `sandbox` when `appflare-sandbox` exists and binds the build bucket,
   * `other` when a Worker by that name is not a sandbox Worker (left alone),
   * `missing` when there is none.
   */
  worker: "sandbox" | "other" | "missing";
  /** The `appflare-builds` bucket exists. */
  bucket: boolean;
  /** Self-deploying apps whose installer token the sandbox Worker holds. */
  appTokens: number;
}

export interface RemovalTargets {
  accountId: string;
  accountName: string;
  manager: ManagerTargets;
  gateway: GatewayState | null;
  sandbox: SandboxTargets;
  /** Cloudflare Access applications in front of the manager; empty when protection is off. */
  accessAppIds: string[];
}

type Binding = Record<string, unknown>;

async function bindingsOf(api: CloudflareClient, workerName: string): Promise<Binding[] | null> {
  try {
    const raw = await api.workers.getBindings(workerName);
    return raw.filter((b): b is Binding => typeof b === "object" && b !== null);
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return null;
    throw error;
  }
}

/** The `JOBS` Workflow, when the manager Worker itself runs it. */
function ownWorkflow(bindings: Binding[], workerName: string): string | null {
  const jobs = bindings.find((b) => b.type === "workflow" && b.name === "JOBS");
  if (jobs === undefined) return null;
  const script = jobs.script_name;
  if (typeof script === "string" && script.length > 0 && script !== workerName) return null;
  const name = jobs.workflow_name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function boundId(bindings: Binding[], type: string, name: string, field: string): string | null {
  const found = bindings.find((b) => b.type === type && b.name === name)?.[field];
  return typeof found === "string" && found.length > 0 ? found : null;
}

/** Whether the build bucket exists; an account that never enabled R2 has none. */
async function hasBuildBucket(api: CloudflareClient): Promise<boolean> {
  try {
    const page = await api.r2.listBucketsPage({ nameContains: SANDBOX_BUCKET_NAME, perPage: 20 });
    return page.items.some((b) => b.name === SANDBOX_BUCKET_NAME);
  } catch (error) {
    if (
      error instanceof CloudflareApiError &&
      error.errors.some((e) => e.code === R2_NOT_ENABLED_CODE)
    ) {
      return false;
    }
    throw error;
  }
}

export async function findRemovalTargets(
  db: D1Database,
  api: CloudflareClient,
): Promise<RemovalTargets> {
  const orm = createDb(db);
  const { worker_name: workerName } = await readSettings(orm, [SETTING.workerName]);
  if (!workerName) {
    throw new DangerError(
      "Appflare does not know its own Worker name yet. Save the Cloudflare token under Settings first.",
      409,
    );
  }
  const account = await api.accounts.get();
  const managerBindings = await bindingsOf(api, workerName);
  if (managerBindings === null) {
    throw new DangerError(
      `Cloudflare has no Worker named "${workerName}" in this account, so Appflare cannot tell what to remove.`,
      409,
    );
  }
  const sandboxBindings = await bindingsOf(api, SANDBOX_WORKER_NAME);
  const isSandbox =
    sandboxBindings?.some((b) => b.type === "r2_bucket" && b.name === SANDBOX_BUCKET_BINDING) ??
    false;
  const appTokens = isSandbox
    ? (sandboxBindings ?? []).filter(
        (b) =>
          b.type === "secret_text" && typeof b.name === "string" && b.name.startsWith("APP_TOKEN_"),
      ).length
    : 0;
  const access = await readAccessConfig(db);
  return {
    accountId: api.accountId,
    accountName: account.name,
    manager: {
      workerName,
      d1Id: boundId(managerBindings, "d1", "DB", "id"),
      kvId: boundId(managerBindings, "kv_namespace", "KV", "namespace_id"),
      workflowName: ownWorkflow(managerBindings, workerName),
    },
    gateway: await readGateway(orm),
    sandbox: {
      worker: sandboxBindings === null ? "missing" : isSandbox ? "sandbox" : "other",
      bucket: await hasBuildBucket(api),
      appTokens,
    },
    accessAppIds:
      access === null
        ? []
        : [access.healthAppId, access.appId].filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
  };
}

export interface ActiveJob {
  id: string;
  kind: string;
}

/**
 * Jobs queued or running, after settling those whose Workflow instance
 * ended without recording it (so a dead instance never blocks the removal).
 */
export async function activeJobs(
  db: D1Database,
  workflows: WorkflowLookup | undefined,
): Promise<ActiveJob[]> {
  const orm = createDb(db);
  const read = () =>
    orm
      .select({
        id: jobs.id,
        kind: jobs.kind,
        status: jobs.status,
        install_id: jobs.install_id,
        workflow_instance_id: jobs.workflow_instance_id,
        input_json: jobs.input_json,
        started_at: jobs.started_at,
      })
      .from(jobs)
      .where(inArray(jobs.status, ["queued", "running"]));
  let rows = await read();
  if (rows.length > 0 && workflows !== undefined && (await reconcileJobs(db, workflows, rows))) {
    rows = await read();
  }
  return rows.map((r) => ({ id: r.id, kind: r.kind }));
}

export function activeJobsMessage(active: readonly ActiveJob[]): string {
  const first = active[0];
  return `${active.length === 1 ? "A job is" : `${active.length} jobs are`} still running${first === undefined ? "" : ` (${first.kind}, /jobs/${first.id})`}. Wait for ${active.length === 1 ? "it" : "them"} to finish, then remove Appflare.`;
}

/** What stays in the account: the installed apps and their custom domains. */
export interface RemovalStays {
  apps: Array<{ label: string; workerName: string }>;
  customDomains: number;
}

export async function readRemovalStays(db: D1Database): Promise<RemovalStays> {
  const orm = createDb(db);
  const rows = await orm
    .select({ displayName: installs.display_name, workerName: installs.worker_name })
    .from(installs)
    .where(ne(installs.status, "uninstalled"))
    .orderBy(asc(installs.worker_name));
  const [domains] = await orm
    .select({ n: count() })
    .from(resources)
    .innerJoin(installs, eq(installs.id, resources.install_id))
    .where(
      and(
        eq(resources.kind, CUSTOM_DOMAIN_KIND),
        isNull(resources.deleted_at),
        ne(installs.status, "uninstalled"),
      ),
    );
  return {
    apps: rows.map((r) => ({ label: installLabel(r), workerName: r.workerName })),
    customDomains: domains?.n ?? 0,
  };
}

/** An external domain an app still has: removing the gateway would take its site down. */
export interface BlockingExternalDomain {
  installId: string;
  /** The app as the UI names it. */
  label: string;
  hostname: string;
}

/**
 * External domains recorded on any install and not removed. While one
 * exists, Appflare is not removed: its visitors reach the app only through
 * the gateway Worker, which the removal deletes.
 */
export async function externalDomainsInUse(db: D1Database): Promise<BlockingExternalDomain[]> {
  const rows = await createDb(db)
    .select({
      installId: installs.id,
      displayName: installs.display_name,
      workerName: installs.worker_name,
      hostname: resources.name,
    })
    .from(resources)
    .innerJoin(installs, eq(installs.id, resources.install_id))
    .where(and(eq(resources.kind, CUSTOM_HOSTNAME_KIND), isNull(resources.deleted_at)))
    .orderBy(asc(installs.worker_name), asc(resources.name));
  return rows.map((r) => ({
    installId: r.installId,
    label: installLabel(r),
    hostname: r.hostname,
  }));
}

export function externalDomainsMessage(domains: readonly BlockingExternalDomain[]): string {
  const apps = new Map<string, { label: string; hostnames: string[] }>();
  for (const d of domains) {
    const app = apps.get(d.installId) ?? { label: d.label, hostnames: [] };
    app.hostnames.push(d.hostname);
    apps.set(d.installId, app);
  }
  const listed = [...apps.entries()]
    .map(([id, a]) => `${a.label} (${a.hostnames.join(", ")}; ${domainsTabPath(id)})`)
    .join("; ");
  return `Apps still have external domains: ${listed}. Remove these external domains first, or their visitors lose the site: they reach the apps only through the gateway, which removing Appflare deletes.`;
}

/** The review dialog's content. */
export interface RemovalReview {
  targets: RemovalTargets;
  stays: RemovalStays;
  activeJobs: ActiveJob[];
  /** Removal is refused while this is not empty. */
  externalDomains: BlockingExternalDomain[];
}

export async function readRemovalReview(
  db: D1Database,
  api: CloudflareClient,
  workflows: WorkflowLookup | undefined,
): Promise<RemovalReview> {
  return {
    targets: await findRemovalTargets(db, api),
    stays: await readRemovalStays(db),
    activeJobs: await activeJobs(db, workflows),
    externalDomains: await externalDomainsInUse(db),
  };
}
