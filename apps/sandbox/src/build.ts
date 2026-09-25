import {
  artifactManifestSchema,
  type BuildFailure,
  type BuildKeys,
  type BuildOutcome,
  type BuildStage,
  buildKeys,
  buildRequestSchema,
  buildStageSchema,
  DEFAULT_SANDBOX_INSTANCE_TYPE,
  type PackageManager,
  SANDBOX_BUCKET_BINDING,
  SANDBOX_PROTOCOL_VERSION,
  type SandboxInstanceType,
  sandboxImage,
} from "@appflare/schema";
import { z } from "zod";
import { BuildLog } from "./log";
import {
  commandLine,
  LOG_FLUSH_INTERVAL_MS,
  MANIFEST_INPUT,
  MOUNT_DIR,
  minutesBetween,
  OUT_DIR,
  packArgv,
  projectDir,
  STAGE_TIMEOUTS,
  sandboxId,
  shellQuote,
} from "./protocol";
import { restartNote, restartOnRuntimeUpdate } from "./restart";
import type { BuildSandbox, ExecOutcome } from "./sandbox";
import { ContainerSteps, messageOf, type RunOptions, StepError } from "./steps";
import { deleteUnder } from "./storage";
import { checkZipFiles } from "./zip-check";

export function isBuildStage(step: string): step is BuildStage {
  return buildStageSchema.safeParse(step).success;
}

/**
 * One sandbox build, start to finish:
 *
 * 1. checkout: shallow-clone the catalog pin's ref and require HEAD to be the
 *    pinned SHA; when the ref has moved (or is not a branch or tag), fetch the
 *    pinned commit itself. A tag can move; the SHA cannot.
 * 2. install: the package manager's frozen install with install scripts
 *    disabled, in an environment without credentials.
 * 3. pack: `appflare-pack --no-install`. The packer runs the catalog
 *    manifest's `install.buildCommand`, if any, in its scrubbed environment
 *    (the manifest is the only source of the build command, and the artifact
 *    records it), then `wrangler deploy --dry-run --outdir`, and writes
 *    `<slug>-<version>.zip` and an unsigned `manifest.json` (`keyId:
 *    "unsigned"`, no signature). A failure of the build command is reported
 *    as the `build` step.
 * 4. upload: mount the build's R2 prefix into the container and copy both
 *    files in.
 * 5. verify: read them back from R2: sizes, the manifest's identity, every
 *    listed file's bytes against its sha256, and the digest the manager
 *    checks against.
 *
 * A new version of this Worker that resets the container before its first
 * command went through sends the build to a fresh container once (restart.ts).
 * The container is destroyed at the end whatever happened. Failures come back
 * as a {@link BuildFailure} naming the step, never as a thrown error, so the
 * manager gets the step, the exit code, and the output over RPC intact.
 */

export interface BuildDeps {
  bucket: R2Bucket;
  /** The sandbox Worker's Appflare version: its image tag. */
  sandboxVersion: string;
  openSandbox(id: string, instanceType: SandboxInstanceType): BuildSandbox;
  now?: () => number;
  flushIntervalMs?: number;
}

/** A failed build step. */
type StageError = StepError<BuildStage>;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the pack step produced, as the container saw it. */
export interface Packed {
  zipName: string;
  zipSize: number;
  manifestSize: number;
}

/**
 * What a build packs: the commit, the artifact version, and the catalog
 * manifest handed to the packer (a catalog entry's, or one worked out from a
 * repository's checkout; see repository.ts).
 */
export interface PackTarget {
  repo: string;
  sha: string;
  version: string;
  subdirectory?: string | undefined;
  catalogManifest: {
    slug: string;
    source: { ref: string };
    install: { packageManager: PackageManager; buildCommand?: string | undefined };
  };
}

/** The steps of one build in its container: checkout and install, pack, upload, verify. */
export class BuildSteps {
  readonly container: ContainerSteps<BuildStage>;

  constructor(
    private readonly sandbox: BuildSandbox,
    private readonly log: BuildLog,
    private readonly request: PackTarget,
    private readonly keys: BuildKeys,
    private readonly bucket: R2Bucket,
  ) {
    this.container = new ContainerSteps(
      sandbox,
      log,
      {
        repo: request.repo,
        sha: request.sha,
        ref: request.catalogManifest.source.ref,
        subdirectory: request.subdirectory,
        packageManager: request.catalogManifest.install.packageManager,
      },
      { checkout: "checkout", install: "install" },
    );
  }

  private get project(): string {
    return projectDir(this.request);
  }

  private run(stage: BuildStage, command: string, options: RunOptions): Promise<ExecOutcome> {
    return this.container.run(stage, command, options);
  }

  checkout(): Promise<void> {
    return this.container.checkout();
  }

  install(): Promise<void> {
    return this.container.install();
  }

  async pack(): Promise<Packed> {
    const { catalogManifest, version } = this.request;
    await this.log.stage("pack", "Packing an unsigned artifact with appflare-pack");
    try {
      await this.sandbox.writeFile(MANIFEST_INPUT, `${JSON.stringify(catalogManifest, null, 2)}\n`);
    } catch (error) {
      throw new StepError<BuildStage>(
        "pack",
        `the build container could not write the catalog manifest: ${messageOf(error)}`,
        null,
        true,
      );
    }
    const declared = catalogManifest.install.buildCommand;
    if (declared !== undefined) {
      this.log.line(`appflare-pack runs install.buildCommand first: ${declared}`);
    }
    try {
      await this.run("pack", commandLine(packArgv(this.project)), {
        cwd: this.project,
        timeoutMs: STAGE_TIMEOUTS.pack,
        failure: "appflare-pack failed",
      });
    } catch (error) {
      // The packer names a failed build command in its error line
      // ("appflare-pack: install.buildCommand ..."): report that as the build.
      if (
        error instanceof StepError &&
        declared !== undefined &&
        /appflare-pack: (could not run )?install\.buildCommand/.test(error.message)
      ) {
        throw new StepError<BuildStage>(
          "build",
          error.message.replace("appflare-pack failed", `the build command \`${declared}\` failed`),
          error.exitCode,
          false,
        );
      }
      throw error;
    }

    const listing = await this.run("pack", `cd ${shellQuote(OUT_DIR)} && stat -c '%s %n' -- *`, {
      timeoutMs: STAGE_TIMEOUTS.quick,
      quiet: true,
    });
    const files = new Map<string, number>();
    for (const line of listing.stdout.split("\n")) {
      const match = /^(\d+) (.+)$/.exec(line.trim());
      if (match?.[1] && match[2]) files.set(match[2], Number(match[1]));
    }
    const zipName = `${catalogManifest.slug}-${version}.zip`;
    const expected = [zipName, "manifest.json"].sort();
    const found = [...files.keys()].sort();
    if (found.join("\n") !== expected.join("\n")) {
      throw new StepError<BuildStage>(
        "pack",
        `the packer wrote ${found.join(", ") || "nothing"}, expected ${expected.join(", ")}. ` +
          `The artifact version comes from install.version or the pin's ref (${catalogManifest.source.ref}) and must be ${version}.`,
        null,
        false,
      );
    }
    const packed = {
      zipName,
      zipSize: files.get(zipName) ?? 0,
      manifestSize: files.get("manifest.json") ?? 0,
    };
    this.log.line(`Packed ${zipName} (${packed.zipSize} bytes).`);
    return packed;
  }

  async upload(packed: Packed): Promise<void> {
    await this.log.stage("upload", `Copying the artifact to R2 under ${this.keys.prefix}`);
    // An earlier build of the same version may have left objects behind.
    await deleteUnder(this.bucket, this.keys.prefix, (key) => key !== this.keys.log);
    try {
      await this.sandbox.mountBucket(
        SANDBOX_BUCKET_BINDING,
        MOUNT_DIR,
        `/${this.keys.prefix.replace(/\/$/, "")}`,
      );
    } catch (error) {
      throw new StepError<BuildStage>(
        "upload",
        `the build bucket could not be mounted in the container: ${messageOf(error)}`,
        null,
        true,
      );
    }
    try {
      const out = shellQuote(OUT_DIR);
      await this.run(
        "upload",
        `cp -- ${out}/manifest.json ${out}/${shellQuote(packed.zipName)} ${shellQuote(MOUNT_DIR)}/ && sync`,
        { timeoutMs: STAGE_TIMEOUTS.upload, failure: "copying the artifact to R2 failed" },
      );
    } finally {
      try {
        await this.sandbox.unmountBucket(MOUNT_DIR);
      } catch (error) {
        this.log.line(`Unmounting the build bucket failed: ${messageOf(error)}`);
      }
    }
  }

  async verify(packed: Packed): Promise<{ digest: string }> {
    const { catalogManifest, version, sha, repo } = this.request;
    await this.log.stage("verify", "Checking the stored artifact");
    const zip = await this.bucket.head(this.keys.artifact);
    if (zip === null || zip.size !== packed.zipSize) {
      throw new StepError<BuildStage>(
        "verify",
        `${this.keys.artifact} ${zip === null ? "is missing" : `has ${zip.size} bytes`} in R2, expected ${packed.zipSize} bytes`,
        null,
        true,
      );
    }
    const stored = await this.bucket.get(this.keys.manifest);
    if (stored === null) {
      throw new StepError<BuildStage>(
        "verify",
        `${this.keys.manifest} is missing in R2`,
        null,
        true,
      );
    }
    const bytes = new Uint8Array(await stored.arrayBuffer());
    if (bytes.byteLength !== packed.manifestSize) {
      throw new StepError<BuildStage>(
        "verify",
        `${this.keys.manifest} has ${bytes.byteLength} bytes in R2, expected ${packed.manifestSize}`,
        null,
        true,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new StepError<BuildStage>(
        "verify",
        "the packed manifest.json is not JSON",
        null,
        false,
      );
    }
    const parsed = artifactManifestSchema.safeParse(json);
    if (!parsed.success) {
      throw new StepError<BuildStage>(
        "verify",
        `the packed manifest.json is not a valid artifact manifest: ${z.prettifyError(parsed.error)}`,
        null,
        false,
      );
    }
    const manifest = parsed.data;
    const problems = [
      manifest.app === catalogManifest.slug ? null : `app is ${manifest.app}`,
      manifest.version === version ? null : `version is ${manifest.version}`,
      manifest.keyId === "unsigned" ? null : `keyId is ${manifest.keyId}`,
      manifest.source.sha === sha ? null : `source.sha is ${manifest.source.sha}`,
      manifest.source.repo === repo ? null : `source.repo is ${manifest.source.repo}`,
    ].filter((p): p is string => p !== null);
    if (problems.length > 0) {
      throw new StepError<BuildStage>(
        "verify",
        `the packed manifest.json does not describe this build: ${problems.join("; ")}`,
        null,
        false,
      );
    }
    const zipBody = await this.bucket.get(this.keys.artifact);
    if (zipBody === null) {
      throw new StepError<BuildStage>(
        "verify",
        `${this.keys.artifact} is missing in R2`,
        null,
        true,
      );
    }
    const zipProblems = await checkZipFiles(zipBody.body, zipBody.size, [
      ...manifest.worker.modules,
      ...manifest.assets.files,
      ...Object.values(manifest.d1Migrations).flat(),
    ]);
    if (zipProblems.length > 0) {
      throw new StepError<BuildStage>(
        "verify",
        `the stored zip does not match manifest.json: ${zipProblems.slice(0, 5).join("; ")}` +
          (zipProblems.length > 5 ? ` (and ${zipProblems.length - 5} more)` : ""),
        null,
        false,
      );
    }
    const digest = await sha256Hex(bytes);
    this.log.line(`Every file in the zip matches manifest.json; manifest.json sha256 ${digest}`);
    return { digest };
  }
}

/** Runs one build. Never throws: every outcome, including a refused request, is returned. */
export async function runBuild(input: unknown, deps: BuildDeps): Promise<BuildOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const common = { protocol: SANDBOX_PROTOCOL_VERSION, sandboxVersion: deps.sandboxVersion };

  const parsed = buildRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      ...common,
      minutes: 0,
      logKey: null,
      log: "",
      stage: "request",
      message: `the build request is not valid:\n${z.prettifyError(parsed.error)}`,
      retryable: false,
      exitCode: null,
    };
  }
  const request = parsed.data;
  const { catalogManifest, installId, version } = request;
  const keys = buildKeys(installId, version, catalogManifest.slug);
  const instanceType = request.instanceType ?? DEFAULT_SANDBOX_INSTANCE_TYPE;
  const image = sandboxImage(deps.sandboxVersion);
  const log = new BuildLog({
    bucket: deps.bucket,
    key: keys.log,
    now,
    flushIntervalMs: deps.flushIntervalMs ?? LOG_FLUSH_INTERVAL_MS,
  });
  log.line(
    `Building ${catalogManifest.slug} ${version} from ${request.repo}@${request.sha} ` +
      `in ${image} (${instanceType}).`,
  );

  let stage: BuildStage = "checkout";
  let sandbox: BuildSandbox | null = null;
  let outcome: BuildOutcome;
  try {
    sandbox = restartOnRuntimeUpdate(
      (id) => deps.openSandbox(id, instanceType),
      await sandboxId(installId, request.sha, request.attempt ?? 1),
      (reason) => log.line(restartNote(reason)),
    );
    const steps = new BuildSteps(sandbox, log, request, keys, deps.bucket);
    await steps.checkout();
    stage = "install";
    await steps.install();
    stage = "pack";
    const packed = await steps.pack();
    stage = "upload";
    await steps.upload(packed);
    stage = "verify";
    const { digest } = await steps.verify(packed);
    outcome = {
      ok: true,
      ...common,
      minutes: 0,
      logKey: keys.log,
      log: "",
      image,
      installId,
      version,
      digest,
      size: packed.zipSize,
      manifestKey: keys.manifest,
      artifactKey: keys.artifact,
    };
  } catch (error) {
    const failure: StageError =
      error instanceof StepError && isBuildStage(error.step)
        ? (error as StageError)
        : new StepError<BuildStage>(
            stage,
            `the build stopped unexpectedly: ${messageOf(error)}`,
            null,
            true,
          );
    log.line(`\nFAILED (${failure.step}): ${failure.message}`);
    outcome = {
      ok: false,
      ...common,
      minutes: 0,
      logKey: keys.log,
      log: "",
      stage: failure.step,
      message: failure.message,
      retryable: failure.retryable,
      exitCode: failure.exitCode,
    };
  }

  if (sandbox !== null) {
    try {
      await sandbox.destroy();
    } catch (error) {
      log.line(`Stopping the build container failed: ${messageOf(error)}`);
    }
  }
  const minutes = minutesBetween(started, now());
  log.line(`${outcome.ok ? "Done" : "Stopped"} after ${minutes} min.`);
  try {
    await log.finish(outcome.ok ? "succeeded" : "failed");
  } catch {
    // The log is progress only; the outcome below carries the same tail.
  }
  return { ...outcome, minutes, log: log.text };
}
