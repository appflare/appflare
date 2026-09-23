import {
  artifactManifestSchema,
  type BuildFailure,
  type BuildKeys,
  type BuildOutcome,
  type BuildRequest,
  type BuildStage,
  buildKeys,
  buildRequestSchema,
  DEFAULT_SANDBOX_INSTANCE_TYPE,
  SANDBOX_BUCKET_BINDING,
  SANDBOX_PROTOCOL_VERSION,
  type SandboxInstanceType,
  sandboxImage,
} from "@appflare/schema";
import { z } from "zod";
import { BuildLog } from "./log";
import {
  BUILD_ENV,
  cloneUrl,
  commandLine,
  installArgv,
  LOG_FLUSH_INTERVAL_MS,
  MANIFEST_INPUT,
  MOUNT_DIR,
  minutesBetween,
  OUT_DIR,
  packArgv,
  projectDir,
  SOURCE_DIR,
  STAGE_TIMEOUTS,
  sandboxId,
  shellQuote,
  tailLines,
  WORK_ROOT,
} from "./protocol";
import type { BuildSandbox, ExecOutcome } from "./sandbox";
import { deleteUnder } from "./storage";
import { checkZipFiles } from "./zip-check";

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

class StageError extends Error {
  constructor(
    readonly stage: BuildStage,
    message: string,
    readonly exitCode: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "StageError";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the pack step produced, as the container saw it. */
interface Packed {
  zipName: string;
  zipSize: number;
  manifestSize: number;
}

class BuildSteps {
  constructor(
    private readonly sandbox: BuildSandbox,
    private readonly log: BuildLog,
    private readonly request: BuildRequest,
    private readonly keys: BuildKeys,
    private readonly bucket: R2Bucket,
  ) {}

  private get project(): string {
    return projectDir(this.request);
  }

  /**
   * Runs one command line; its output streams into the log. A command that
   * cannot be run at all (the container did not start or went away) is
   * retryable; one that exits non-zero is not.
   */
  private async run(
    stage: BuildStage,
    command: string,
    options: { cwd?: string; timeoutMs: number; failure?: string; quiet?: boolean },
  ): Promise<ExecOutcome> {
    if (!options.quiet) this.log.line(`$ ${command}`);
    let output = "";
    let result: ExecOutcome;
    try {
      result = await this.sandbox.exec(command, {
        cwd: options.cwd,
        env: BUILD_ENV,
        timeoutMs: options.timeoutMs,
        onOutput: (chunk) => {
          output = (output + chunk).slice(-64 * 1024);
          if (!options.quiet) this.log.append(chunk);
        },
      });
    } catch (error) {
      throw new StageError(
        stage,
        `the build container could not run \`${command}\`: ${messageOf(error)}`,
        null,
        true,
      );
    }
    if (result.exitCode !== 0) {
      const tail = tailLines(output || `${result.stdout}\n${result.stderr}`);
      throw new StageError(
        stage,
        `${options.failure ?? `\`${command}\` failed`} (exit code ${result.exitCode})${tail ? `:\n${tail}` : ""}`,
        result.exitCode,
        false,
      );
    }
    return result;
  }

  private async head(): Promise<string> {
    const result = await this.run("checkout", `git -C ${shellQuote(SOURCE_DIR)} rev-parse HEAD`, {
      timeoutMs: STAGE_TIMEOUTS.quick,
      quiet: true,
    });
    return result.stdout.trim();
  }

  async checkout(): Promise<void> {
    const { repo, sha, catalogManifest } = this.request;
    const ref = catalogManifest.source.ref;
    await this.log.stage("checkout", `Checking out ${repo} at ${sha} (${ref})`);
    await this.run(
      "checkout",
      `rm -rf ${shellQuote(WORK_ROOT)} && mkdir -p ${shellQuote(WORK_ROOT)}`,
      {
        timeoutMs: STAGE_TIMEOUTS.quick,
      },
    );

    let cloned = false;
    try {
      await this.sandbox.gitCheckout(cloneUrl(repo), {
        branch: ref,
        targetDir: SOURCE_DIR,
        depth: 1,
        cloneTimeoutMs: STAGE_TIMEOUTS.checkout,
      });
      cloned = true;
    } catch (error) {
      this.log.line(`Cloning ${ref} did not work (${messageOf(error)}); fetching ${sha} directly.`);
    }

    let head = cloned ? await this.head() : "";
    if (head !== sha) {
      if (cloned) {
        this.log.line(`${ref} is at ${head}, not the pinned ${sha}; fetching the pinned commit.`);
      }
      const src = shellQuote(SOURCE_DIR);
      const init = cloned
        ? []
        : [
            `rm -rf ${src}`,
            `git init -q ${src}`,
            `git -C ${src} remote add origin ${shellQuote(cloneUrl(repo))}`,
          ];
      await this.run(
        "checkout",
        [
          ...init,
          `git -C ${src} fetch -q --depth 1 origin ${sha}`,
          `git -C ${src} checkout -q --detach FETCH_HEAD`,
        ].join(" && "),
        {
          timeoutMs: STAGE_TIMEOUTS.checkout,
          failure: `the pinned commit ${sha} could not be fetched from ${repo}`,
        },
      );
      head = await this.head();
    }
    if (head !== sha) {
      throw new StageError(
        "checkout",
        `the checkout is at ${head || "no commit"}, not the pinned ${sha}`,
        null,
        false,
      );
    }
    this.log.line(`HEAD is ${sha}.`);
    if (this.request.subdirectory) {
      await this.run("checkout", `test -d ${shellQuote(this.project)}`, {
        timeoutMs: STAGE_TIMEOUTS.quick,
        failure: `the subdirectory ${this.request.subdirectory} does not exist at ${sha}`,
      });
    }
  }

  async install(): Promise<void> {
    const packageManager = this.request.catalogManifest.install.packageManager;
    await this.log.stage(
      "install",
      `Installing dependencies with ${packageManager}, scripts disabled`,
    );
    await this.run("install", commandLine(installArgv(packageManager)), {
      cwd: this.project,
      timeoutMs: STAGE_TIMEOUTS.install,
      failure: "installing the dependencies failed",
    });
  }

  async pack(): Promise<Packed> {
    const { catalogManifest, version } = this.request;
    await this.log.stage("pack", "Packing an unsigned artifact with appflare-pack");
    try {
      await this.sandbox.writeFile(MANIFEST_INPUT, `${JSON.stringify(catalogManifest, null, 2)}\n`);
    } catch (error) {
      throw new StageError(
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
        error instanceof StageError &&
        declared !== undefined &&
        /appflare-pack: (could not run )?install\.buildCommand/.test(error.message)
      ) {
        throw new StageError(
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
      throw new StageError(
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
      throw new StageError(
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
      throw new StageError(
        "verify",
        `${this.keys.artifact} ${zip === null ? "is missing" : `has ${zip.size} bytes`} in R2, expected ${packed.zipSize} bytes`,
        null,
        true,
      );
    }
    const stored = await this.bucket.get(this.keys.manifest);
    if (stored === null) {
      throw new StageError("verify", `${this.keys.manifest} is missing in R2`, null, true);
    }
    const bytes = new Uint8Array(await stored.arrayBuffer());
    if (bytes.byteLength !== packed.manifestSize) {
      throw new StageError(
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
      throw new StageError("verify", "the packed manifest.json is not JSON", null, false);
    }
    const parsed = artifactManifestSchema.safeParse(json);
    if (!parsed.success) {
      throw new StageError(
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
      throw new StageError(
        "verify",
        `the packed manifest.json does not describe this build: ${problems.join("; ")}`,
        null,
        false,
      );
    }
    const zipBody = await this.bucket.get(this.keys.artifact);
    if (zipBody === null) {
      throw new StageError("verify", `${this.keys.artifact} is missing in R2`, null, true);
    }
    const zipProblems = await checkZipFiles(zipBody.body, zipBody.size, [
      ...manifest.worker.modules,
      ...manifest.assets.files,
      ...Object.values(manifest.d1Migrations).flat(),
    ]);
    if (zipProblems.length > 0) {
      throw new StageError(
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
    sandbox = deps.openSandbox(await sandboxId(installId, request.sha), instanceType);
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
    const failure =
      error instanceof StageError
        ? error
        : new StageError(stage, `the build stopped unexpectedly: ${messageOf(error)}`, null, true);
    log.line(`\nFAILED (${failure.stage}): ${failure.message}`);
    outcome = {
      ok: false,
      ...common,
      minutes: 0,
      logKey: keys.log,
      log: "",
      stage: failure.stage,
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
