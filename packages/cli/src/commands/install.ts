import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureAccount } from "../account.ts";
import { unpackArtifact, verifyArtifact } from "../artifact.ts";
import { type CommandContext, wranglerFor } from "../context.ts";
import { parseDeployOutput } from "../deploy-output.ts";
import { waitForHealth } from "../health.ts";
import { managerPageLines, managerPageRef } from "../manager-pages.ts";
import { autoProvisionedResourceName, DEFAULT_WORKER_NAME, validateWorkerName } from "../names.ts";
import { checkNodeVersion } from "../node-version.ts";
import { downloadManagerRelease, findManagerRelease } from "../release.ts";
import { formatManagerUrl, generateBetterAuthSecret } from "../secrets.ts";
import { withWorkdir } from "../workdir.ts";
import { listD1Databases, listDeployments, listKvNamespaces } from "../worker-info.ts";
import { type Wrangler, WranglerError, wranglerArgs } from "../wrangler.ts";
import { buildWranglerConfig, type GeneratedWranglerConfig } from "../wrangler-config.ts";

/** Options of `create-appflare`. */
export interface InstallOptions {
  /** Manager release to install (`manager@<version>`); the newest published one by default. */
  version?: string;
  /** Read `manifest.json`, `manifest.sig`, and the zip from here instead of downloading. */
  artifactDir?: string;
  /** Worker name; `appflare` by default. */
  name?: string;
  /** Never prompt; fail where a prompt would be needed. */
  yes: boolean;
  /** Accept an artifact without manifest.sig. Only with `APPFLARE_DEV=1` and `--artifact-dir`. */
  allowUnsigned: boolean;
}

/**
 * Refuses to install over anything: an existing Worker of that name, or a D1
 * database or KV namespace with the name wrangler would provision (wrangler
 * would silently attach an existing D1 database of that name, and fail on a
 * duplicate KV title halfway through the deploy).
 */
async function preflight(wrangler: Wrangler, config: GeneratedWranglerConfig): Promise<void> {
  const { name } = config;
  if ((await listDeployments(wrangler, name)) !== null) {
    throw new Error(
      `A Worker named "${name}" already exists in this account. If it is an Appflare manager, ` +
        `open it and update it from ${managerPageRef(null, "updates")}; otherwise ` +
        "install another copy with --name <other>.",
    );
  }
  const databases = await listD1Databases(wrangler);
  for (const { database_name } of config.d1_databases ?? []) {
    if (databases.some((db) => db.name === database_name)) {
      throw new Error(
        `A D1 database named "${database_name}" already exists (left over from an earlier install?). ` +
          `Delete it with \`npx wrangler d1 delete ${database_name}\`, or install under another --name.`,
      );
    }
  }
  const namespaces = await listKvNamespaces(wrangler);
  for (const { binding } of config.kv_namespaces ?? []) {
    const title = autoProvisionedResourceName(name, binding);
    const existing = namespaces.find((ns) => ns.title === title);
    if (existing) {
      throw new Error(
        `A KV namespace named "${title}" already exists (left over from an earlier install?). ` +
          `Delete it with \`npx wrangler kv namespace delete --namespace-id ${existing.id}\`, ` +
          "or install under another --name.",
      );
    }
  }
}

/**
 * The wrangler commands that delete what a deploy created, in an order that
 * works: the Worker first, then its Workflows (Cloudflare keeps them when the
 * Worker goes), D1 database, and KV namespace (by title, which is the name
 * wrangler provisioned it under).
 */
export function startOverCommands(config: GeneratedWranglerConfig): string[] {
  return [
    `npx wrangler delete --name ${config.name}`,
    ...(config.workflows ?? []).map((w) => `npx wrangler workflows delete ${w.name}`),
    ...(config.d1_databases ?? []).map((db) => `npx wrangler d1 delete ${db.database_name}`),
    ...(config.kv_namespaces ?? []).map(
      (kv) =>
        `npx wrangler kv namespace delete ${autoProvisionedResourceName(config.name, kv.binding)}`,
    ),
  ];
}

/**
 * `create-appflare`: log in, fetch and verify the signed
 * manager release, deploy it from a temp dir with D1 and KV auto-provisioned,
 * set its auth secret, and print the manager's URL. The URL carries nothing
 * secret: the first screen there asks for a Cloudflare API token for this
 * account, which is proof enough to finish setup. The temp dir is removed on
 * every path; nothing is written to the current directory.
 */
export async function install(options: InstallOptions, ctx: CommandContext): Promise<void> {
  const { ui, env, telemetry } = ctx;
  if (telemetry) telemetry.step = "node_version";
  checkNodeVersion(ctx.nodeVersion);
  if (telemetry) {
    telemetry.step = "start";
    telemetry.nameIsDefault = (options.name ?? DEFAULT_WORKER_NAME) === DEFAULT_WORKER_NAME;
  }
  const name = validateWorkerName(options.name ?? DEFAULT_WORKER_NAME);
  if (options.version !== undefined && options.artifactDir !== undefined) {
    throw new Error("--version and --artifact-dir cannot be used together");
  }
  if (options.allowUnsigned) {
    if (env.APPFLARE_DEV !== "1") {
      throw new Error("--allow-unsigned is a development flag and needs APPFLARE_DEV=1");
    }
    if (options.artifactDir === undefined) {
      throw new Error("--allow-unsigned only applies to --artifact-dir");
    }
    ui.warn("*************************************************************************");
    ui.warn("  --allow-unsigned: the manager artifact's signature is NOT required.");
    ui.warn("  Development use only. Never install an unsigned manager you care about.");
    ui.warn("*************************************************************************");
  }

  await withWorkdir(async ({ dir, neutralConfig }) => {
    const wrangler = wranglerFor(ctx, dir, neutralConfig);
    await ensureAccount(wrangler, ui, { env, yes: options.yes, telemetry });
    if (telemetry) telemetry.step = "release_download";

    let artifactDir: string;
    let expectedVersion: string | undefined;
    if (options.artifactDir !== undefined) {
      artifactDir = path.resolve(options.artifactDir);
      ui.step(`Reading the manager artifact from ${artifactDir}`);
    } else {
      ui.step("Downloading the manager release");
      const release = await findManagerRelease(ctx.fetch, env, options.version, (m) => ui.warn(m));
      artifactDir = path.join(dir, "release");
      await mkdir(artifactDir);
      await downloadManagerRelease(ctx.fetch, env, release, artifactDir);
      expectedVersion = release.version;
      ui.info(`Release ${release.tag}`);
    }

    if (telemetry) telemetry.step = "verify";
    const verified = await verifyArtifact({
      dir: artifactDir,
      allowUnsigned: options.allowUnsigned,
      keys: ctx.keys,
      expectedVersion,
    });
    const { manifest } = verified;
    if (telemetry) telemetry.managerVersion = manifest.version;
    ui.info(
      verified.keyId
        ? `Signature OK (key ${verified.keyId}), Appflare ${manifest.version}`
        : `UNSIGNED Appflare ${manifest.version} (--allow-unsigned)`,
    );

    const projectDir = path.join(dir, "project");
    const unpacked = await unpackArtifact(manifest, verified.zipPath, projectDir);
    ui.info(`Checked ${unpacked.moduleCount} Worker modules and ${unpacked.assetCount} assets`);
    // With usage data on, the manager continues this run's install id; with it
    // off (flag or environment), the manager is deployed with it off too.
    const config = buildWranglerConfig(manifest, {
      name,
      ...(telemetry ? { vars: telemetry.managerVars() } : {}),
    });
    const configPath = path.join(projectDir, "wrangler.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    if (telemetry) telemetry.step = "preflight";
    ui.step("Checking the account for an existing install");
    await preflight(wrangler, config);

    ui.step(
      `Deploying the manager as "${name}" (wrangler creates its D1 database and KV namespace)`,
    );
    if (telemetry) telemetry.step = "deploy";
    const outputFile = path.join(dir, "wrangler-output.ndjson");
    const deploy = await wrangler.run(wranglerArgs.deploy(configPath), {
      // Without --yes, a terminal lets wrangler ask before taking over a
      // Workflow name another Worker owns, or to register a workers.dev
      // subdomain on a new account. With --yes (or no terminal) stdin is
      // closed: wrangler runs non-interactively, `--strict` aborts on a
      // conflict, and a missing subdomain fails with wrangler's instructions.
      stdin: ui.interactive && !options.yes ? { kind: "inherit" } : { kind: "ignore" },
      output: "stream",
      env: { WRANGLER_OUTPUT_FILE_PATH: outputFile },
    });
    if (deploy.code !== 0) {
      throw new Error(
        `\`wrangler deploy\` failed (exit code ${deploy.code}); see its output above.`,
      );
    }

    try {
      // Inside the try: from here on the Worker is live, so any failure must
      // come with the advice on how to start over.
      const deployed = parseDeployOutput(await readFile(outputFile, "utf8").catch(() => ""), name);
      if (telemetry) telemetry.step = "secrets";
      ui.step("Setting the manager's secret");
      const secretName = "BETTER_AUTH_SECRET";
      const result = await wrangler.run(wranglerArgs.secretPut(name, secretName), {
        stdin: { kind: "text", text: generateBetterAuthSecret() },
      });
      if (result.code !== 0) {
        throw new WranglerError(`secret put ${secretName}`, result);
      }
      ui.info(`${secretName} set`);

      if (telemetry) telemetry.step = "health";
      ui.step(`Waiting for ${deployed.url} to answer`);
      const health = await waitForHealth(ctx.fetch, deployed.url, {
        sleep: ctx.sleep,
        timeoutMs: ctx.healthTimeoutMs,
      });
      if (health.ok) {
        ui.info(`The manager is up (version ${health.version})`);
      } else {
        ui.warn(
          `The manager has not answered yet (${health.reason}). A new workers.dev URL can take a ` +
            "minute; open the address below again shortly.",
        );
      }

      ui.step(
        "Done. Open your manager to finish setup (you will paste a Cloudflare API token, then create the owner account):",
      );
      const managerUrl = formatManagerUrl(deployed.url);
      ui.result(managerUrl);
      for (const line of managerPageLines(managerUrl)) ui.info(line);
    } catch (error) {
      ui.warn(
        `The manager Worker "${name}" was deployed, but setup did not finish. To start over, ` +
          "delete what it created, then run create-appflare again:",
      );
      for (const command of startOverCommands(config)) ui.warn(`  ${command}`);
      throw error;
    }
  }, ctx.tmpRoot);
}
