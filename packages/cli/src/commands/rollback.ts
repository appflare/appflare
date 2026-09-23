import { ensureAccount } from "../account.ts";
import { type CommandContext, wranglerFor } from "../context.ts";
import { describeHealth, waitForHealth } from "../health.ts";
import { DEFAULT_WORKER_NAME, validateWorkerName } from "../names.ts";
import { withWorkdir } from "../workdir.ts";
import {
  activeVersionId,
  appflareVersionOf,
  listDeployments,
  listVersions,
  previousVersionId,
  viewVersion,
} from "../worker-info.ts";
import { resolveWorkersDevUrl } from "../workers-dev.ts";
import { wranglerArgs } from "../wrangler.ts";
import { describeVersion } from "./status.ts";

export interface RollbackOptions {
  name?: string;
  /** Version id to roll back to; the previous deployment's version by default. */
  to?: string;
  /** Print the recent versions (ids and dates, for `--to`) and change nothing. */
  list?: boolean;
  /** The manager's URL for the health check afterwards; looked up when omitted. */
  url?: string;
  yes: boolean;
}

/** The deployment message recorded on a CLI rollback. */
export const ROLLBACK_MESSAGE = "Rollback with @appflare/cli";

/**
 * `appflare rollback`: `--list` prints recent versions; otherwise redeploys an earlier version of the manager with
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
    if (options.list) {
      const versions = await listVersions(wrangler, name);
      const previous = previousVersionId(deployments);
      ui.result(
        [
          `Recent versions of "${name}" (newest first, * = active)`,
          ...versions
            .slice()
            .reverse()
            .map(
              (v) =>
                `${describeVersion(v, current)}${v.id === previous ? "  <- default rollback target" : ""}`,
            ),
          "",
          `Roll back with: npx @appflare/cli rollback --name ${name} --to <version-id>`,
        ].join("\n"),
      );
      return;
    }
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

    const appflareOf = async (versionId: string | null) => {
      if (!versionId) {
        return null;
      }
      const version = await viewVersion(wrangler, name, versionId).catch(() => null);
      return version ? appflareVersionOf(version) : null;
    };
    const describe = (versionId: string | null, appflare: string | null) =>
      versionId ? `${versionId}${appflare ? ` (Appflare ${appflare})` : ""}` : "none";
    const targetAppflare = await appflareOf(target);
    ui.info(`Current:         ${describe(current, await appflareOf(current))}`);
    ui.info(`Rolling back to: ${describe(target, targetAppflare)}`);
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

    // Check the manager answers again, and with the rolled-back version once
    // the new deployment has reached the edge (usually a few seconds).
    const url = options.url ?? (await resolveWorkersDevUrl(wrangler, ctx.fetch, name));
    let healthLine = "not checked (no URL; pass --url)";
    if (url) {
      ui.step(`Checking ${url}/api/health`);
      const health = await waitForHealth(ctx.fetch, url, {
        sleep: ctx.sleep,
        timeoutMs: ctx.healthTimeoutMs ?? 60_000,
        accept: (h) => targetAppflare === null || h.version === targetAppflare,
      });
      healthLine = describeHealth(health);
      if (health.ok && targetAppflare !== null && health.version !== targetAppflare) {
        healthLine += `; expected ${targetAppflare}, the edge may still be serving the old version`;
      }
    }
    ui.result([`Rolled back "${name}" to version ${target}.`, `Health: ${healthLine}`].join("\n"));
  }, ctx.tmpRoot);
}
