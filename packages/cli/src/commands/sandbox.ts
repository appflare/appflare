import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SANDBOX_BUCKET_NAME, SANDBOX_WORKER_NAME } from "@appflare/schema";
import { ensureAccount } from "../account.ts";
import { type ApiAccess, type WranglerCredential, wranglerCredential } from "../api-token.ts";
import { SANDBOX_APP, unpackArtifact, verifyArtifact } from "../artifact.ts";
import { type CommandContext, wranglerFor } from "../context.ts";
import { checkNodeVersion } from "../node-version.ts";
import { downloadRelease, findRelease, SANDBOX_RELEASES } from "../release.ts";
import { type BucketState, bucketState, emptyBucket } from "../sandbox-bucket.ts";
import {
  buildSandboxWranglerConfig,
  explainContainersAccess,
  explainSandboxDeployFailure,
  hasSandboxBindings,
  isContainerAccessFailure,
  SANDBOX_CONTAINERS,
} from "../sandbox-config.ts";
import { checkContainersAccess, findContainerApplications } from "../sandbox-containers.ts";
import { withWorkdir } from "../workdir.ts";
import {
  activeVersionId,
  appflareVersionOf,
  listDeployments,
  type VersionBinding,
  viewVersion,
} from "../worker-info.ts";
import { isWorkerNotFound, type Wrangler, wranglerArgs } from "../wrangler.ts";

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

/** The account and bearer token for the Cloudflare API calls wrangler has no command for. */
function apiAccess(wrangler: Wrangler, credential: WranglerCredential | null): ApiAccess | null {
  return wrangler.accountId && credential?.token
    ? { accountId: wrangler.accountId, token: credential.token }
    : null;
}

/**
 * Stops before anything is uploaded when the credential cannot reach
 * Containers: wrangler would otherwise create the bucket and upload the
 * Worker, and fail only at its container application step. Checked for API
 * tokens and `wrangler login` alike, because a login on the free plan is
 * refused the same way. A global API key has no bearer token to check with.
 */
async function checkContainersAccessBeforeDeploy(
  ctx: CommandContext,
  credential: WranglerCredential | null,
  access: ApiAccess | null,
): Promise<void> {
  if (credential?.type === "api_key") {
    return;
  }
  ctx.ui.step("Checking that the credential can use Containers");
  const firstContainer = SANDBOX_CONTAINERS[0].name;
  const checked = access
    ? await checkContainersAccess(ctx.fetch, access, firstContainer)
    : ({ kind: "unknown", reason: "wrangler has no API credential to give" } as const);
  if (checked.kind === "denied") {
    throw new Error(
      `${explainContainersAccess({ apiToken: credential?.type === "api_token" })}\n` +
        `(Listing container applications answered HTTP ${checked.status}. Nothing was uploaded.)`,
    );
  }
  if (checked.kind === "unknown") {
    ctx.ui.warn(`Could not check access to Containers (${checked.reason}); deploying anyway.`);
    return;
  }
  ctx.ui.info("The credential can use Containers.");
}

/** Deletes the sandbox Worker; `missing` when there is none by that name. */
async function deleteSandboxWorker(
  wrangler: Wrangler,
): Promise<{ kind: "deleted" } | { kind: "missing" } | { kind: "failed"; code: number }> {
  const result = await wrangler.run(wranglerArgs.delete(SANDBOX_WORKER_NAME), {
    stdin: { kind: "ignore" },
    output: "tee",
  });
  if (result.code === 0) {
    return { kind: "deleted" };
  }
  return isWorkerNotFound(result) ? { kind: "missing" } : { kind: "failed", code: result.code };
}

/** What existed before `sandbox enable` deployed, so a failed deploy removes only what it created. */
interface BeforeDeploy {
  workerExisted: boolean;
  bucket: BucketState;
}

/** How far the failed deploy got. */
interface DeployFailure {
  /**
   * Whether wrangler uploaded the Worker ("Uploaded appflare-sandbox"). Only
   * then is a Worker that did not exist before this run's own: another run
   * may have created one in the meantime. wrangler runs its container
   * application step only after the upload.
   */
  uploaded: boolean;
  /** Cloudflare refused Containers at the container application step. */
  containersRefused: boolean;
  /** The version this run deployed, for the summary. */
  version: string;
}

/**
 * Removes what a failed `sandbox enable` created: the Worker, when this run
 * uploaded it and there was none before (with any container applications it
 * got), and the build bucket, when this run created it. A bucket is only
 * ever deleted empty: Cloudflare refuses to delete one that holds objects,
 * and it is never emptied here. Returns the lines for the error message.
 */
async function rollBackEnable(
  wrangler: Wrangler,
  ctx: CommandContext,
  before: BeforeDeploy,
  failure: DeployFailure,
  access: ApiAccess | null,
): Promise<string[]> {
  const { ui } = ctx;
  const lines: string[] = [];
  if (before.workerExisted) {
    lines.push(
      failure.uploaded
        ? `The Worker "${SANDBOX_WORKER_NAME}" existed before this run and was kept. wrangler ` +
            `had already uploaded ${failure.version} to it, so it may now run that version ` +
            "without its container applications updated; run `npx @appflare/cli sandbox enable` " +
            "again once the cause is fixed."
        : `The Worker "${SANDBOX_WORKER_NAME}" existed before this run and was left as it was.`,
    );
  } else if (failure.uploaded) {
    ui.step(`Rolling back: deleting the Worker "${SANDBOX_WORKER_NAME}" this run uploaded`);
    const deleted = await deleteSandboxWorker(wrangler);
    if (deleted.kind === "deleted") {
      lines.push(`Removed the Worker "${SANDBOX_WORKER_NAME}" this run uploaded.`);
    } else if (deleted.kind === "missing") {
      lines.push(`The Worker "${SANDBOX_WORKER_NAME}" was already gone; nothing to remove.`);
    } else {
      lines.push(
        `FAILED to remove the Worker "${SANDBOX_WORKER_NAME}" (wrangler exit code ${deleted.code}; ` +
          "see above); `npx @appflare/cli sandbox disable --yes` removes it.",
      );
    }
    // Attempted even after a refusal: an application may have been created
    // before a later request was refused.
    ui.step("Rolling back: removing the sandbox Worker's container applications");
    lines.push(
      ...(await deleteSandboxContainers(wrangler, ctx, {
        quietWhenRefused: failure.containersRefused,
      })),
    );
  }

  if (before.bucket === "present") {
    lines.push(`The R2 bucket ${SANDBOX_BUCKET_NAME} existed before this run, so it was kept.`);
  } else if (before.bucket === "unknown") {
    lines.push(
      `Could not tell whether the R2 bucket ${SANDBOX_BUCKET_NAME} existed before this run, so it ` +
        "was kept; `npx @appflare/cli sandbox disable --yes --purge` deletes it.",
    );
  } else if (
    access !== null &&
    (await bucketState(ctx.fetch, access, SANDBOX_BUCKET_NAME)) === "present"
  ) {
    ui.step(`Rolling back: deleting the empty R2 bucket ${SANDBOX_BUCKET_NAME} this run created`);
    const result = await wrangler.run(wranglerArgs.r2BucketDelete(SANDBOX_BUCKET_NAME), {
      stdin: { kind: "ignore" },
      output: "stream",
    });
    lines.push(
      result.code === 0
        ? `Removed the R2 bucket ${SANDBOX_BUCKET_NAME} this run created.`
        : `FAILED to remove the R2 bucket ${SANDBOX_BUCKET_NAME} this run created (wrangler exit code ` +
            `${result.code}; see above). It is only deleted while empty; ` +
            "`npx @appflare/cli sandbox disable --yes --purge` empties and deletes it.",
    );
  }
  return lines;
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
    const credential = await wranglerCredential(wrangler);
    const access = apiAccess(wrangler, credential);
    await checkContainersAccessBeforeDeploy(ctx, credential, access);

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
    // Recorded before deploying, so a failed deploy removes only what it created.
    const before: BeforeDeploy = {
      workerExisted: existing !== null,
      bucket: access ? await bucketState(ctx.fetch, access, SANDBOX_BUCKET_NAME) : "unknown",
    };

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
      const output = `${deploy.stdout}\n${deploy.stderr}`;
      const explained = explainSandboxDeployFailure(output, {
        apiToken: credential?.type === "api_token",
      });
      const rolledBack = await rollBackEnable(
        wrangler,
        ctx,
        before,
        {
          uploaded: output.includes(`Uploaded ${SANDBOX_WORKER_NAME}`),
          containersRefused: isContainerAccessFailure(output),
          version: manifest.version,
        },
        access,
      );
      throw new Error(
        [
          explained ??
            `\`wrangler deploy\` failed (exit code ${deploy.code}); see its output above.`,
          ...rolledBack,
        ].join("\n"),
      );
    }

    ui.step("Done.");
    ui.result(
      [
        `The Appflare sandbox Worker ${manifest.version} is deployed as "${SANDBOX_WORKER_NAME}" (no public URL).`,
        "It builds sandbox tier apps from their pinned commit in your account.",
        "Next, connect your manager to it: open the manager's Settings > Sandbox builds and choose",
        "Connect sandbox builds. Sandbox tier and self-deploying apps then install through it.",
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
async function deleteSandboxContainers(
  wrangler: Wrangler,
  ctx: CommandContext,
  options: {
    /**
     * Say nothing when the lookup is refused (401/403): after Cloudflare
     * refused Containers to this credential, it created none with it either.
     */
    quietWhenRefused?: boolean;
  } = {},
): Promise<string[]> {
  const names = SANDBOX_CONTAINERS.map((c) => c.name);
  const found = await findContainerApplications(wrangler, ctx.fetch, names);
  if (!found.ok) {
    if (options.quietWhenRefused && (found.status === 401 || found.status === 403)) {
      return [];
    }
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
      const deleted = await deleteSandboxWorker(wrangler);
      if (deleted.kind === "failed") {
        throw new Error(
          `\`wrangler delete\` failed (exit code ${deleted.code}); see its output above. Nothing else was deleted.`,
        );
      }
      lines.push(
        deleted.kind === "deleted"
          ? `Deleted the Worker "${SANDBOX_WORKER_NAME}".`
          : `The Worker "${SANDBOX_WORKER_NAME}" was already gone; nothing to delete there.`,
      );
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
