import { ensureAccount } from "../account.ts";
import { type CommandContext, wranglerFor } from "../context.ts";
import { DEFAULT_WORKER_NAME, validateWorkerName } from "../names.ts";
import { withWorkdir } from "../workdir.ts";
import {
  activeVersionId,
  listD1Databases,
  listDeployments,
  listKvNamespaces,
  type VersionBinding,
  viewVersion,
} from "../worker-info.ts";
import { type Wrangler, wranglerArgs } from "../wrangler.ts";

export interface UninstallOptions {
  name?: string;
  yes: boolean;
}

/** A resource of the manager that uninstall leaves in place, and how to delete it. */
export interface LeftoverResource {
  description: string;
  deleteCommand: string;
}

/**
 * The manager's own D1 databases and KV namespaces, from the
 * bindings of its active version, with the command that deletes each.
 * `d1Names`/`kvTitles` map ids to names; ids stand in when a name is unknown.
 */
export function leftoverResources(
  bindings: VersionBinding[],
  d1Names: Map<string, string>,
  kvTitles: Map<string, string>,
): LeftoverResource[] {
  const leftovers: LeftoverResource[] = [];
  for (const binding of bindings) {
    if (binding.type === "d1" && typeof binding.id === "string") {
      const dbName = d1Names.get(binding.id);
      leftovers.push({
        description: `D1 database ${dbName ? `"${dbName}" ` : ""}(${binding.id}), binding ${binding.name}`,
        deleteCommand: `npx wrangler d1 delete ${dbName ?? binding.id}`,
      });
    } else if (binding.type === "kv_namespace" && typeof binding.namespace_id === "string") {
      const title = kvTitles.get(binding.namespace_id);
      leftovers.push({
        description: `KV namespace ${title ? `"${title}" ` : ""}(${binding.namespace_id}), binding ${binding.name}`,
        deleteCommand: `npx wrangler kv namespace delete --namespace-id ${binding.namespace_id}`,
      });
    }
  }
  return leftovers;
}

async function namesById(wrangler: Wrangler): Promise<[Map<string, string>, Map<string, string>]> {
  // Best effort: only used to label the leftovers.
  const d1 = await listD1Databases(wrangler).catch(() => []);
  const kv = await listKvNamespaces(wrangler).catch(() => []);
  return [new Map(d1.map((db) => [db.uuid, db.name])), new Map(kv.map((ns) => [ns.id, ns.title]))];
}

/**
 * `appflare uninstall --yes`: deletes the manager Worker only.
 * Installed apps and their resources stay. The manager's own D1 database, KV
 * namespace stay too, listed with the commands that delete them. Its Workflow
 * is deleted with the Worker (confirmed against a live account).
 */
export async function uninstall(options: UninstallOptions, ctx: CommandContext): Promise<void> {
  const name = validateWorkerName(options.name ?? DEFAULT_WORKER_NAME);
  const { ui } = ctx;
  if (!options.yes) {
    throw new Error(
      `uninstall deletes the manager Worker "${name}". Run it again with --yes to confirm.`,
    );
  }
  await withWorkdir(async ({ dir, neutralConfig }) => {
    const wrangler = wranglerFor(ctx, dir, neutralConfig);
    // `--yes` confirms the deletion only; with several accounts the user is
    // still asked which one (or sets CLOUDFLARE_ACCOUNT_ID).
    await ensureAccount(wrangler, ui, { env: ctx.env, yes: false });
    const deployments = await listDeployments(wrangler, name);
    if (deployments === null) {
      throw new Error(`There is no Worker named "${name}" in this account.`);
    }
    const active = activeVersionId(deployments);
    const bindings = active ? (await viewVersion(wrangler, name, active)).resources.bindings : [];
    const [d1Names, kvTitles] = await namesById(wrangler);
    const leftovers = leftoverResources(bindings, d1Names, kvTitles);

    ui.step(`Deleting the Worker "${name}"`);
    const result = await wrangler.run(wranglerArgs.delete(name), {
      stdin: { kind: "ignore" },
      output: "stream",
    });
    if (result.code !== 0) {
      throw new Error(
        `\`wrangler delete\` failed (exit code ${result.code}); see its output above.`,
      );
    }

    // TODO: delete the manager's own D1 database and KV namespace through
    // the API once the CLI can prove they belong to this manager; wrangler has
    // no safe way to tell, and a name match alone could delete someone's data.
    const lines = [
      `Deleted the Worker "${name}".`,
      "Apps you installed with Appflare, and their resources, were not touched.",
    ];
    if (leftovers.length > 0) {
      lines.push(
        "The manager's own resources were NOT deleted:",
        ...leftovers.map((r) => `  - ${r.description}`),
        "Delete them yourself if you no longer need the data:",
        ...leftovers.map((r) => `  ${r.deleteCommand}`),
      );
    }
    ui.result(lines.join("\n"));
  }, ctx.tmpRoot);
}
