import { ensureAccount } from "../account.ts";
import { type CommandContext, wranglerFor } from "../context.ts";
import { DEFAULT_WORKER_NAME, validateWorkerName } from "../names.ts";
import { withWorkdir } from "../workdir.ts";
import {
  activeVersionId,
  appflareVersionOf,
  listDeployments,
  previousVersionId,
  viewVersion,
} from "../worker-info.ts";
import { wranglerArgs } from "../wrangler.ts";

export interface RollbackOptions {
  name?: string;
  /** Version id to roll back to; the previous deployment's version by default. */
  to?: string;
  yes: boolean;
}

/** The deployment message recorded on a CLI rollback. */
export const ROLLBACK_MESSAGE = "Rollback with @appflare/cli";

/**
 * `appflare rollback`: redeploys an earlier version of the manager with
 * `wrangler rollback`, so it works when the manager's UI is broken (the
 * escape hatch). Rolls back the Worker only; D1 data is not touched.
 */
export async function rollback(options: RollbackOptions, ctx: CommandContext): Promise<void> {
  const name = validateWorkerName(options.name ?? DEFAULT_WORKER_NAME);
  const { ui } = ctx;
  await withWorkdir(async ({ dir, neutralConfig }) => {
    const wrangler = wranglerFor(ctx, dir, neutralConfig);
    await ensureAccount(wrangler, ui, { env: ctx.env, yes: options.yes });
    const deployments = await listDeployments(wrangler, name);
    if (deployments === null) {
      throw new Error(`There is no Worker named "${name}" in this account.`);
    }
    const current = activeVersionId(deployments);
    const target = options.to ?? previousVersionId(deployments);
    if (!target) {
      throw new Error(
        `"${name}" has no earlier deployment to roll back to; pass --to <version-id> ` +
          `(see \`npx @appflare/cli status --name ${name}\`).`,
      );
    }
    if (target === current) {
      throw new Error(`Version ${target} is already the active version of "${name}".`);
    }

    const describe = async (versionId: string | null) => {
      if (!versionId) {
        return "none";
      }
      const version = await viewVersion(wrangler, name, versionId).catch(() => null);
      const appflare = version ? appflareVersionOf(version) : null;
      return `${versionId}${appflare ? ` (Appflare ${appflare})` : ""}`;
    };
    ui.info(`Current:     ${await describe(current)}`);
    ui.info(`Rolling back to: ${await describe(target)}`);
    ui.info("Only the Worker is rolled back; data in its D1 database stays as it is.");

    if (!options.yes) {
      if (!ui.interactive) {
        throw new Error("Pass --yes to roll back without a prompt.");
      }
      if (!(await ui.confirm(`Roll back "${name}" to ${target}?`))) {
        ui.info("Nothing changed.");
        return;
      }
    }

    ui.step("Rolling back");
    // No stdin: wrangler takes its defaults instead of asking again; the user
    // confirmed above.
    const result = await wrangler.run(wranglerArgs.rollback(name, target, ROLLBACK_MESSAGE), {
      stdin: { kind: "ignore" },
      output: "stream",
    });
    if (result.code !== 0) {
      throw new Error(
        `\`wrangler rollback\` failed (exit code ${result.code}); see its output above.`,
      );
    }
    ui.result(`Rolled back "${name}" to version ${target}.`);
  }, ctx.tmpRoot);
}
