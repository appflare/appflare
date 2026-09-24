import { ensureAccount } from "../account.ts";
import { type CommandContext, wranglerFor } from "../context.ts";
import { checkHealth } from "../health.ts";
import { autoProvisionedResourceName, DEFAULT_WORKER_NAME, validateWorkerName } from "../names.ts";
import { withWorkdir } from "../workdir.ts";
import {
  activeVersionId,
  type D1Database,
  type KvNamespace,
  listD1Databases,
  listDeployments,
  listKvNamespaces,
  type VersionBinding,
  viewVersion,
} from "../worker-info.ts";
import { resolveWorkersDevUrl } from "../workers-dev.ts";
import { type Wrangler, wranglerArgs } from "../wrangler.ts";

export interface UninstallOptions {
  name?: string;
  yes: boolean;
  /** Also delete the manager's own D1 database and KV namespace. */
  purge?: boolean;
  /** With `--yes --purge`, skip typing the manager's name. */
  iUnderstandDataLoss?: boolean;
  /** The manager's URL, for recognizing it by its health answer; looked up when omitted. */
  url?: string;
}

/** One D1 database or KV namespace of the manager. */
export interface ManagerResource {
  kind: "d1" | "kv";
  /** The D1 uuid or KV namespace id. */
  id: string;
  /** The D1 database name or KV namespace title; null when the account does not list it. */
  name: string | null;
  /** The binding it is bound as, when known. */
  binding: string | null;
}

export function describeResource(r: ManagerResource): string {
  const label = r.kind === "d1" ? "D1 database" : "KV namespace";
  return `${label} ${r.name ? `"${r.name}" ` : ""}(${r.id})${r.binding ? `, binding ${r.binding}` : ""}`;
}

export function deleteCommandFor(r: ManagerResource): string {
  return r.kind === "d1"
    ? `npx wrangler d1 delete ${r.name ?? r.id}`
    : `npx wrangler kv namespace delete --namespace-id ${r.id}`;
}

/**
 * The Workflow the manager Worker runs as `JOBS`, when it runs it itself (a
 * binding to another Worker's Workflow names that Worker in `script_name`).
 * Cloudflare keeps a Workflow, with its instances, when the Worker that runs
 * it is deleted, so uninstall deletes it by name after the Worker.
 */
export function ownWorkflowName(bindings: VersionBinding[], workerName: string): string | null {
  const jobs = bindings.find((b) => b.type === "workflow" && b.name === "JOBS");
  if (jobs === undefined) return null;
  const script = jobs.script_name;
  if (typeof script === "string" && script.length > 0 && script !== workerName) return null;
  const name = jobs.workflow_name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/** wrangler's output when the Workflow does not exist (API code 10200). */
function workflowNotFound(output: string): boolean {
  return /\b10200\b|workflow\.not_found/.test(output);
}

/**
 * The D1 databases and KV namespaces bound to a Worker version, by id, labelled
 * with their names where the account lists them.
 */
export function boundResources(
  bindings: VersionBinding[],
  databases: D1Database[],
  namespaces: KvNamespace[],
): ManagerResource[] {
  const resources: ManagerResource[] = [];
  for (const binding of bindings) {
    if (binding.type === "d1" && typeof binding.id === "string") {
      const id = binding.id;
      const name = databases.find((db) => db.uuid === id)?.name ?? null;
      resources.push({ kind: "d1", id, name, binding: binding.name });
    } else if (binding.type === "kv_namespace" && typeof binding.namespace_id === "string") {
      const id = binding.namespace_id;
      const name = namespaces.find((ns) => ns.id === id)?.title ?? null;
      resources.push({ kind: "kv", id, name, binding: binding.name });
    }
  }
  return resources;
}

/**
 * Whether a Worker version has the manager's bindings: the `DB` database,
 * the `KV` namespace, the `JOBS` Workflow running `JobWorkflow`, and the
 * `APPFLARE_VERSION` var. An app that merely shares the name does not.
 */
export function hasManagerBindings(bindings: VersionBinding[]): boolean {
  const has = (type: string, name: string, extra: (b: VersionBinding) => boolean = () => true) =>
    bindings.some((b) => b.type === type && b.name === name && extra(b));
  return (
    has("d1", "DB") &&
    has("kv_namespace", "KV") &&
    has("workflow", "JOBS", (b) => b.class_name === "JobWorkflow") &&
    has("plain_text", "APPFLARE_VERSION")
  );
}

/**
 * The D1 database named exactly `<name>` and the KV namespace titled exactly
 * `<name>-kv` (the names the installer gives them). Used only when the manager
 * Worker is already gone and its bindings cannot be read.
 */
export function resourcesByName(
  name: string,
  databases: D1Database[],
  namespaces: KvNamespace[],
): ManagerResource[] {
  const resources: ManagerResource[] = [];
  const db = databases.find((d) => d.name === name);
  if (db) resources.push({ kind: "d1", id: db.uuid, name: db.name, binding: null });
  const title = autoProvisionedResourceName(name, "KV");
  const ns = namespaces.find((n) => n.title === title);
  if (ns) resources.push({ kind: "kv", id: ns.id, name: ns.title, binding: null });
  return resources;
}

/**
 * Whether the Worker is an Appflare manager: its bindings have the manager's
 * shape, or its `/api/health` answers like a manager (version, database
 * status, and schema version).
 */
async function isManager(
  wrangler: Wrangler,
  ctx: CommandContext,
  name: string,
  bindings: VersionBinding[],
  url: string | undefined,
): Promise<boolean> {
  if (hasManagerBindings(bindings)) {
    return true;
  }
  const workerUrl = url ?? (await resolveWorkersDevUrl(wrangler, ctx.fetch, name));
  if (!workerUrl) {
    return false;
  }
  const health = await checkHealth(ctx.fetch, workerUrl);
  return health.ok && typeof health.schemaVersion === "number";
}

async function confirmPurge(
  ctx: CommandContext,
  name: string,
  resources: ManagerResource[],
  byName: boolean,
  options: UninstallOptions,
): Promise<void> {
  const { ui } = ctx;
  if (options.yes && options.iUnderstandDataLoss) {
    ui.warn(
      `--i-understand-data-loss: deleting "${name}" and its data without asking` +
        `${byName ? " (matched by name: the Worker is gone)" : ""}.`,
    );
    return;
  }
  if (!ui.interactive) {
    throw new Error(
      "--purge deletes the manager's data. Run it in a terminal to confirm by typing the " +
        "manager's name, or pass --yes --purge --i-understand-data-loss.",
    );
  }
  if (byName) {
    ui.warn(
      `There is no Worker named "${name}", so its bindings cannot be read. Matching by name ` +
        `instead: only the D1 database named exactly "${name}" and the KV namespace titled ` +
        `exactly "${autoProvisionedResourceName(name, "KV")}". Make sure they are this manager's.`,
    );
  }
  ui.warn("--purge permanently deletes the manager's own data:");
  for (const r of resources) {
    ui.warn(`  ${describeResource(r)}`);
  }
  ui.warn(
    "Your users, settings, install records, and job history are in them. This cannot be undone.",
  );
  const typed = await ui.text(`Type the manager's name (${name}) to confirm`, name);
  if (typed.trim() !== name) {
    throw new Error("The name did not match; nothing was deleted.");
  }
}

/**
 * `appflare uninstall --yes [--purge]`: deletes the manager Worker, then its
 * Workflow (Cloudflare keeps a Workflow when its Worker is deleted).
 * Installed apps and their resources are never touched, and a Worker that is
 * not an Appflare manager is refused.
 *
 * Without `--purge` the manager's own D1 database and KV namespace stay and
 * are listed with the commands that delete them. With `--purge` they are
 * deleted too, after the user types the manager's name: exactly the ones the
 * manager Worker is bound to, by id. Only when the Worker is already gone are
 * they found by exact name instead, and the prompt says so.
 */
export async function uninstall(options: UninstallOptions, ctx: CommandContext): Promise<void> {
  const name = validateWorkerName(options.name ?? DEFAULT_WORKER_NAME);
  const { ui } = ctx;
  if (!options.yes) {
    throw new Error(
      `uninstall deletes the manager Worker "${name}". Run it again with --yes to confirm.`,
    );
  }
  if (options.iUnderstandDataLoss && !options.purge) {
    throw new Error("--i-understand-data-loss only applies to --purge");
  }
  await withWorkdir(async ({ dir, neutralConfig }) => {
    const wrangler = wranglerFor(ctx, dir, neutralConfig);
    // `--yes` confirms the deletion only; with several accounts the user is
    // still asked which one (or sets CLOUDFLARE_ACCOUNT_ID).
    await ensureAccount(wrangler, ui, { env: ctx.env, yes: false, telemetry: ctx.telemetry });
    const deployments = await listDeployments(wrangler, name);
    if (deployments === null && !options.purge) {
      throw new Error(`There is no Worker named "${name}" in this account.`);
    }
    const active = deployments ? activeVersionId(deployments) : null;
    const bindings = active ? (await viewVersion(wrangler, name, active)).resources.bindings : [];
    ctx.telemetry?.useManagerBindings(bindings);
    if (deployments !== null && !(await isManager(wrangler, ctx, name, bindings, options.url))) {
      throw new Error(
        `The Worker "${name}" is not an Appflare manager (it lacks the manager's bindings and ` +
          "health answer), so uninstall will not touch it or its resources. If it is an app " +
          "installed with Appflare, remove it from the manager instead.",
      );
    }

    // Required for --purge; without it, best effort, only to label the leftovers.
    const lenient = <T>(p: Promise<T[]>) => (options.purge ? p : p.catch((): T[] => []));
    const databases = await lenient(listD1Databases(wrangler));
    const namespaces = await lenient(listKvNamespaces(wrangler));
    const bound = boundResources(bindings, databases, namespaces);
    const byName = deployments === null;
    const targets = options.purge
      ? byName
        ? resourcesByName(name, databases, namespaces)
        : bound
      : [];
    if (options.purge) {
      await confirmPurge(ctx, name, targets, byName, options);
    }

    const lines: string[] = [];
    if (deployments === null) {
      lines.push(`There is no Worker named "${name}"; nothing to delete there.`);
    } else {
      ui.step(`Deleting the Worker "${name}"`);
      const result = await wrangler.run(wranglerArgs.delete(name), {
        stdin: { kind: "ignore" },
        output: "stream",
      });
      if (result.code !== 0) {
        throw new Error(
          `\`wrangler delete\` failed (exit code ${result.code}); see its output above. Nothing else was deleted.`,
        );
      }
      lines.push(`Deleted the Worker "${name}".`);
    }

    const deleted = new Set<string>();
    let failed = false;
    const workflow = deployments === null ? null : ownWorkflowName(bindings, name);
    if (workflow !== null) {
      ui.step(`Deleting the Workflow "${workflow}" and its job history`);
      const result = await wrangler.run(wranglerArgs.workflowsDelete(workflow), {
        stdin: { kind: "ignore" },
        output: "capture",
      });
      if (result.code === 0) {
        lines.push(`Deleted the Workflow "${workflow}".`);
      } else if (workflowNotFound(`${result.stdout}\n${result.stderr}`)) {
        lines.push(`The Workflow "${workflow}" was already gone.`);
      } else {
        failed = true;
        lines.push(
          `FAILED to delete the Workflow "${workflow}" (wrangler exit code ${result.code}). Delete it with \`npx wrangler workflows delete ${workflow}\`.`,
        );
      }
    }
    if (options.purge) {
      if (targets.length === 0) {
        lines.push(
          byName
            ? `No D1 database named "${name}" or KV namespace titled "${autoProvisionedResourceName(name, "KV")}"; nothing to purge.`
            : "The manager had no D1 database or KV namespace bound; nothing to purge.",
        );
      }
      for (const target of targets) {
        const label = describeResource(target);
        if (target.kind === "d1" && target.name === null) {
          // wrangler deletes D1 databases by name only.
          failed = true;
          lines.push(`Could not delete ${label}: the account does not list it.`);
          continue;
        }
        ui.step(`Deleting the ${label}`);
        const args =
          target.kind === "d1"
            ? wranglerArgs.d1Delete(target.name as string)
            : wranglerArgs.kvDelete(target.id);
        const result = await wrangler.run(args, { stdin: { kind: "ignore" }, output: "stream" });
        if (result.code === 0) {
          deleted.add(target.id);
          lines.push(`Deleted the ${label}.`);
        } else {
          failed = true;
          lines.push(
            `FAILED to delete the ${label} (wrangler exit code ${result.code}; see above).`,
          );
        }
      }
    }

    lines.push("Apps you installed with Appflare, and their resources, were not touched.");
    const leftovers = [
      ...bound,
      ...targets.filter((t) => !bound.some((b) => b.id === t.id)),
    ].filter((r) => !deleted.has(r.id));
    if (leftovers.length > 0) {
      lines.push(
        options.purge
          ? "These resources of the manager were NOT deleted:"
          : "The manager's own resources were NOT deleted:",
        ...leftovers.map((r) => `  - ${describeResource(r)}`),
        `Delete them yourself if you no longer need the data${options.purge ? "" : " (or run uninstall with --purge)"}:`,
        ...leftovers.map((r) => `  ${deleteCommandFor(r)}`),
      );
    }
    ui.result(lines.join("\n"));
    if (failed) {
      throw new Error("Some of the manager's resources could not be deleted; see above.");
    }
  }, ctx.tmpRoot);
}
