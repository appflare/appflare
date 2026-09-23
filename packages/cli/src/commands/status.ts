import { ensureAccount } from "../account.ts";
import { type CommandContext, wranglerFor } from "../context.ts";
import { checkHealth, describeHealth, describeUpdate } from "../health.ts";
import { DEFAULT_WORKER_NAME, validateWorkerName } from "../names.ts";
import { withWorkdir } from "../workdir.ts";
import {
  activeVersionId,
  appflareVersionOf,
  type Deployment,
  listDeployments,
  listVersions,
  type Version,
  viewVersion,
} from "../worker-info.ts";
import { resolveWorkersDevUrl } from "../workers-dev.ts";

export interface StatusOptions {
  name?: string;
  /** The manager's URL; looked up from the account's workers.dev subdomain when omitted. */
  url?: string;
}

function annotation(record: { annotations?: Record<string, unknown> }, key: string): string | null {
  const value = record.annotations?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function describeDeployment(deployment: Deployment): string[] {
  const lines = [
    `  Deployed:  ${deployment.created_on}${deployment.author_email ? ` by ${deployment.author_email}` : ""}` +
      `${deployment.source ? ` (${deployment.source})` : ""}`,
  ];
  const message = annotation(deployment, "workers/message");
  if (message) {
    lines.push(`  Message:   ${message}`);
  }
  for (const v of deployment.versions) {
    lines.push(`  Version:   ${v.version_id} (${v.percentage}%)`);
  }
  return lines;
}

/** One line per version for `status` and `rollback --list`. */
export function describeVersion(version: Version, active: string | null): string {
  const marker = version.id === active ? "*" : " ";
  const message = annotation(version, "workers/message");
  return `  ${marker} ${version.id}  ${version.metadata.created_on}  ${version.metadata.source ?? ""}${message ? `  ${message}` : ""}`.trimEnd();
}

/**
 * `appflare status`: the active deployment and recent versions (from wrangler,
 * so it works when the manager itself is broken), the deployed Appflare
 * version, `GET /api/health`, and whether a newer release is available (as the
 * manager's own release check last saw it).
 */
export async function status(options: StatusOptions, ctx: CommandContext): Promise<void> {
  const name = validateWorkerName(options.name ?? DEFAULT_WORKER_NAME);
  const { ui } = ctx;
  await withWorkdir(async ({ dir, neutralConfig }) => {
    const wrangler = wranglerFor(ctx, dir, neutralConfig);
    await ensureAccount(wrangler, ui, { env: ctx.env, yes: false });
    ui.step(`Reading "${name}"`);
    const deployments = await listDeployments(wrangler, name);
    if (deployments === null) {
      throw new Error(`There is no Worker named "${name}" in this account.`);
    }
    const active = activeVersionId(deployments);
    const detail = active ? await viewVersion(wrangler, name, active) : null;
    const versions = await listVersions(wrangler, name);
    const url = options.url ?? (await resolveWorkersDevUrl(wrangler, ctx.fetch, name));
    const health = url ? await checkHealth(ctx.fetch, url) : null;

    const latest = deployments.at(-1);
    const lines = [
      `Appflare manager "${name}"`,
      `  URL:       ${url ?? "unknown (pass --url https://<name>.<subdomain>.workers.dev)"}`,
      `  Appflare:  ${(detail && appflareVersionOf(detail)) ?? "unknown"} (active deployment)`,
      `  Health:    ${describeHealth(health)}`,
      `  Updates:   ${describeUpdate(health)}`,
      "",
      "Active deployment",
      ...(latest ? describeDeployment(latest) : ["  none"]),
      "",
      "Recent versions (newest first, * = active)",
      ...versions
        .slice()
        .reverse()
        .map((v) => describeVersion(v, active)),
    ];
    ui.result(lines.join("\n"));
  }, ctx.tmpRoot);
}
