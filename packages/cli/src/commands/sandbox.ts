import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SANDBOX_BUCKET_NAME, SANDBOX_WORKER_NAME } from "@appflare/schema";
import { ensureAccount } from "../account.ts";
import { SANDBOX_APP, unpackArtifact, verifyArtifact } from "../artifact.ts";
import { type CommandContext, wranglerFor } from "../context.ts";
import { checkNodeVersion } from "../node-version.ts";
import { downloadRelease, findRelease, SANDBOX_RELEASES } from "../release.ts";
import { emptyBucket } from "../sandbox-bucket.ts";
import {
  buildSandboxWranglerConfig,
  explainSandboxDeployFailure,
  hasSandboxBindings,
  SANDBOX_CONTAINERS,
} from "../sandbox-config.ts";
import { findContainerApplications } from "../sandbox-containers.ts";
import { withWorkdir } from "../workdir.ts";
import {
  activeVersionId,
  appflareVersionOf,
  listDeployments,
  type VersionBinding,
  viewVersion,
} from "../worker-info.ts";
import { type Wrangler, wranglerArgs } from "../wrangler.ts";

/**
 * `appflare sandbox enable|disable`: the optional sandbox Worker that builds
 * `sandbox` tier apps in Cloudflare Containers in the user's own account.
 * Workers Paid only. Deployed the way the manager is: from a signed release
 * (`sandbox@<version>`), with wrangler, from a generated config in a temp
 * directory that is removed afterwards.
 */

export interface SandboxEnableOptions {
  /** Sandbox Worker release to deploy (`sandbox@<version>`); the newest published one by default. */
  version?: string;
  /** Read `manifest.json`, `manifest.sig`, and the zip from here instead of downloading. */
  artifactDir?: string;
  yes: boolean;
  /** Accept an artifact without manifest.sig. Only with `APPFLARE_DEV=1` and `--artifact-dir`. */
  allowUnsigned: boolean;
}

export interface SandboxDisableOptions {
  yes: boolean;
  /** Also delete the build bucket and everything in it. */
  purge: boolean;
  /** With `--yes --purge`, skip typing the sandbox Worker's name. */
  iUnderstandDataLoss: boolean;
}

/** What one build costs, for the enable summary and the docs. */
export const BUILD_COST_NOTE =
  "Each build runs a standard-1 container (1/2 vCPU, 4 GiB) for as long as it takes; a " +
  "10-minute build costs about US$0.012 beyond the usage Workers Paid includes each month " +
  "(about 35 such builds).";

/** The deployed sandbox Worker's bindings and version, or null when there is no Worker by that name. */
async function deployedSandboxWorker(
  wrangler: Wrangler,
): Promise<{ bindings: VersionBinding[]; version: string | null } | null> {
  const deployments = await listDeployments(wrangler, SANDBOX_WORKER_NAME);
  if (deployments === null) {
    return null;
  }
  const active = activeVersionId(deployments);
  if (active === null) {
    return { bindings: [], version: null };
  }
  const version = await viewVersion(wrangler, SANDBOX_WORKER_NAME, active);
  return { bindings: version.resources.bindings, version: appflareVersionOf(version) };
}

function notASandboxWorker(): Error {
  return new Error(
    `A Worker named "${SANDBOX_WORKER_NAME}" exists in this account but is not an Appflare ` +
      "sandbox Worker (it lacks its Sandbox Durable Object, build bucket, and version bindings), so it is " +
      "left alone. Rename or delete it first.",
  );
}

export async function sandboxEnable(
  options: SandboxEnableOptions,
  ctx: CommandContext,
): Promise<void> {
  const { ui, env } = ctx;
  checkNodeVersion(ctx.nodeVersion);
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
    ui.warn(
      "--allow-unsigned: the sandbox Worker artifact's signature is NOT required (development only).",
    );
  }

  await withWorkdir(async ({ dir, neutralConfig }) => {
    const wrangler = wranglerFor(ctx, dir, neutralConfig);
    await ensureAccount(wrangler, ui, { env, yes: options.yes });

    let artifactDir: string;
    let expectedVersion: string | undefined;
    if (options.artifactDir !== undefined) {
      artifactDir = path.resolve(options.artifactDir);
      ui.step(`Reading the sandbox Worker artifact from ${artifactDir}`);
    } else {
      ui.step("Downloading the sandbox Worker release");
      const release = await findRelease(SANDBOX_RELEASES, ctx.fetch, env, options.version, (m) =>
        ui.warn(m),
      );
      artifactDir = path.join(dir, "release");
      await mkdir(artifactDir);
      await downloadRelease(ctx.fetch, env, release, artifactDir);
      expectedVersion = release.version;
      ui.info(`Release ${release.tag}`);
    }
    const verified = await verifyArtifact({
      dir: artifactDir,
      allowUnsigned: options.allowUnsigned,
      keys: ctx.keys,
      expectedVersion,
      app: SANDBOX_APP,
    });
    const { manifest } = verified;
    ui.info(
      verified.keyId
        ? `Signature OK (key ${verified.keyId}), sandbox Worker ${manifest.version}`
        : `UNSIGNED sandbox Worker ${manifest.version} (--allow-unsigned)`,
    );

    const projectDir = path.join(dir, "project");
    await unpackArtifact(manifest, verified.zipPath, projectDir);
    const config = buildSandboxWranglerConfig(manifest);
    const configPath = path.join(projectDir, "wrangler.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    ui.step("Checking the account for an existing sandbox Worker");
    const existing = await deployedSandboxWorker(wrangler);
    if (existing !== null && !hasSandboxBindings(existing.bindings)) {
      throw notASandboxWorker();
    }
    ui.info(
      existing === null
        ? "No sandbox Worker yet; deploying a new one."
        : `Replacing sandbox Worker ${existing.version ?? "(unknown version)"} with ${manifest.version}.`,
    );

    ui.step(
      `Deploying the sandbox Worker "${SANDBOX_WORKER_NAME}" with image ${config.containers[0]?.image} ` +
        `(wrangler creates the R2 bucket ${SANDBOX_BUCKET_NAME} if it is missing)`,
    );
    // Non-interactive and strict: nothing here needs a question, and
    // --strict stops instead of overwriting changes made elsewhere. The output
    // is shown and also kept, to reword a plan error.
    const deploy = await wrangler.run(wranglerArgs.deploy(configPath), {
      stdin: { kind: "ignore" },
      output: "tee",
    });
    if (deploy.code !== 0) {
      const explained = explainSandboxDeployFailure(`${deploy.stdout}\n${deploy.stderr}`);
      throw new Error(
        explained ?? `\`wrangler deploy\` failed (exit code ${deploy.code}); see its output above.`,
      );
    }

    ui.step("Done.");
    ui.result(
      [
        `The Appflare sandbox Worker ${manifest.version} is deployed as "${SANDBOX_WORKER_NAME}" (no public URL).`,
        "It builds sandbox tier apps from their pinned commit in your account. The manager's side",
        "(connecting to it and installing sandbox tier apps) comes in a following Appflare release.",
        BUILD_COST_NOTE,
        "Remove it with `npx @appflare/cli sandbox disable --yes`.",
      ].join("\n"),
    );
  }, ctx.tmpRoot);
}

/**
 * Deletes the sandbox Worker's container applications if they outlived the Worker.
 * Best effort: returns what it could not do, for the summary.
 */
async function deleteSandboxContainers(wrangler: Wrangler, ctx: CommandContext): Promise<string[]> {
  const names = SANDBOX_CONTAINERS.map((c) => c.name);
  const found = await findContainerApplications(wrangler, ctx.fetch, names);
  if (!found.ok) {
    return [
      `Could not look up the container applications ${names.join(" and ")} (${found.reason}); ` +
        "if they are still listed under Workers > Containers in the dashboard, delete them there.",
    ];
  }
  const problems: string[] = [];
  for (const app of found.applications) {
    const result = await wrangler.run(wranglerArgs.containersDelete(app.id), {
      stdin: { kind: "ignore" },
      output: "stream",
    });
    if (result.code !== 0) {
      problems.push(
        `FAILED to delete the container application ${app.name} (${app.id}); delete it with ` +
          `\`npx wrangler containers delete ${app.id}\`.`,
      );
    }
  }
  return problems;
}

async function confirmPurge(ctx: CommandContext, options: SandboxDisableOptions): Promise<void> {
  const { ui } = ctx;
  if (options.yes && options.iUnderstandDataLoss) {
    ui.warn(`--i-understand-data-loss: deleting the bucket ${SANDBOX_BUCKET_NAME} without asking.`);
    return;
  }
  if (!ui.interactive) {
    throw new Error(
      "--purge deletes every build output and log. Run it in a terminal to confirm by typing " +
        "the sandbox Worker's name, or pass --yes --purge --i-understand-data-loss.",
    );
  }
  ui.warn(
    `--purge permanently deletes the R2 bucket ${SANDBOX_BUCKET_NAME}: every build output and ` +
      "build log. Apps already installed keep running, but the manager cannot reinstall, update " +
      "from, or roll back to a build it no longer has without building again.",
  );
  const typed = await ui.text(
    `Type the sandbox Worker's name (${SANDBOX_WORKER_NAME}) to confirm`,
    SANDBOX_WORKER_NAME,
  );
  if (typed.trim() !== SANDBOX_WORKER_NAME) {
    throw new Error("The name did not match; nothing was deleted.");
  }
}

export async function sandboxDisable(
  options: SandboxDisableOptions,
  ctx: CommandContext,
): Promise<void> {
  const { ui } = ctx;
  if (!options.yes) {
    throw new Error(
      `sandbox disable deletes the sandbox Worker "${SANDBOX_WORKER_NAME}". Run it again with --yes to confirm.`,
    );
  }
  if (options.iUnderstandDataLoss && !options.purge) {
    throw new Error("--i-understand-data-loss only applies to --purge");
  }
  await withWorkdir(async ({ dir, neutralConfig }) => {
    const wrangler = wranglerFor(ctx, dir, neutralConfig);
    await ensureAccount(wrangler, ui, { env: ctx.env, yes: false });
    const existing = await deployedSandboxWorker(wrangler);
    if (existing === null && !options.purge) {
      throw new Error(`There is no sandbox Worker ("${SANDBOX_WORKER_NAME}") in this account.`);
    }
    if (existing !== null && !hasSandboxBindings(existing.bindings)) {
      throw notASandboxWorker();
    }
    if (options.purge) {
      await confirmPurge(ctx, options);
    }

    const lines: string[] = [];
    let failed = false;
    if (existing === null) {
      lines.push(`There is no Worker named "${SANDBOX_WORKER_NAME}"; nothing to delete there.`);
    } else {
      ui.step(`Deleting the Worker "${SANDBOX_WORKER_NAME}"`);
      const result = await wrangler.run(wranglerArgs.delete(SANDBOX_WORKER_NAME), {
        stdin: { kind: "ignore" },
        output: "stream",
      });
      if (result.code !== 0) {
        throw new Error(
          `\`wrangler delete\` failed (exit code ${result.code}); see its output above. Nothing else was deleted.`,
        );
      }
      lines.push(`Deleted the Worker "${SANDBOX_WORKER_NAME}".`);
    }
    ui.step("Removing the sandbox Worker's container applications");
    const containerProblems = await deleteSandboxContainers(wrangler, ctx);
    lines.push(...containerProblems);

    if (options.purge) {
      ui.step(`Emptying and deleting the R2 bucket ${SANDBOX_BUCKET_NAME}`);
      const emptied = await emptyBucket(wrangler, ctx.fetch, SANDBOX_BUCKET_NAME, {
        sleep: ctx.sleep,
      });
      if (emptied.kind === "missing") {
        lines.push(`There is no bucket ${SANDBOX_BUCKET_NAME}; nothing to purge.`);
      } else if (emptied.kind === "failed") {
        failed = true;
        lines.push(
          `FAILED to empty the bucket ${SANDBOX_BUCKET_NAME}: ${emptied.reason}. Delete it in the ` +
            "Cloudflare dashboard (R2 empties a bucket before deleting it), or run this again.",
        );
      } else {
        const result = await wrangler.run(wranglerArgs.r2BucketDelete(SANDBOX_BUCKET_NAME), {
          stdin: { kind: "ignore" },
          output: "stream",
        });
        if (result.code === 0) {
          lines.push(
            `Deleted the bucket ${SANDBOX_BUCKET_NAME} (${emptied.deletedObjects} objects).`,
          );
        } else {
          failed = true;
          lines.push(
            `FAILED to delete the bucket ${SANDBOX_BUCKET_NAME} (wrangler exit code ${result.code}; see above).`,
          );
        }
      }
    } else {
      lines.push(
        `The R2 bucket ${SANDBOX_BUCKET_NAME} with build outputs and logs was kept; ` +
          "`appflare sandbox enable` uses it again, and `sandbox disable --yes --purge` deletes it.",
      );
    }
    lines.push(
      "Apps built by the sandbox Worker keep running. Until the sandbox Worker is enabled again, the manager " +
        "cannot build, update, or reinstall sandbox tier apps.",
    );
    ui.result(lines.join("\n"));
    if (failed) {
      throw new Error("Some of the sandbox Worker's resources could not be deleted; see above.");
    }
  }, ctx.tmpRoot);
}
