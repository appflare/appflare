import {
  type BuildCommandChoice,
  type BuildStage,
  buildCommandText,
  buildKeys,
  type CatalogManifest,
  catalogManifestSchema,
  DEFAULT_SANDBOX_INSTANCE_TYPE,
  isCommitSha,
  type PackageManager,
  parseInspectOutput,
  type RepositoryBuildOutcome,
  type RepositoryBuildRequest,
  type RepositoryDetection,
  repositoryBuildRequestSchema,
  SANDBOX_PROTOCOL_VERSION,
  sandboxImage,
  type WranglerFacts,
} from "@appflare/schema";
import { z } from "zod";
import { type BuildDeps, BuildSteps, isBuildStage, type PackTarget } from "./build";
import { gitTokenEnv, tokenRedactions } from "./github";
import { BuildLog } from "./log";
import {
  BUILD_ENV,
  cloneUrl,
  commandLine,
  DETECTION_READ_LIMIT,
  inspectArgv,
  LOG_FLUSH_INTERVAL_MS,
  minutesBetween,
  repositorySandboxId,
  SOURCE_DIR,
  STAGE_TIMEOUTS,
  shellQuote,
  WORK_ROOT,
} from "./protocol";
import {
  artifactVersion,
  chooseBuildCommand,
  DETECTION_FILES,
  DetectionError,
  detectPackageManager,
  detectWranglerConfig,
  type PackageFacts,
  parseSecretsExample,
  readPackageFacts,
  repositoryManifest,
  secretsFile,
  secretsSource,
  sourceBuildManifest,
} from "./repository-manifest";
import { restartNote, restartOnRuntimeUpdate } from "./restart";
import type { BuildSandbox } from "./sandbox";
import { CommandRunner, messageOf, StepError } from "./steps";

/**
 * A build from a repository, start to finish (`SandboxBuilds.buildRepository`):
 *
 * 1. checkout: shallow-clone the GitHub repository at the branch or tag
 *    asked for (its default branch when none), or fetch the commit asked
 *    for; when the caller named the commit too, HEAD must end up there. A
 *    private repository is fetched with the GitHub access token the request
 *    names (see github.ts): only the fetch commands get it, through git's
 *    environment, never the command line or the remote URL, and never the
 *    install or the build, which run the repository's own code.
 * 2. detect: read the root of the checkout (see repository-manifest.ts) and
 *    write the catalog manifest the packer takes: worked out from the
 *    repository, or for a catalog app built from source, the catalog's own
 *    with the new commit.
 * 3. install, pack, upload, verify: exactly as a sandbox tier build
 *    (build.ts), so the artifact is one the manager reads the same way.
 *
 * The log lives under the caller's run id (`builds/<installId>/<runId>/`),
 * since the artifact's version is known only after step 2. Never throws:
 * every outcome, a refused request included, is returned.
 */

type StageError = StepError<BuildStage>;

/** The checkout: which commit, reached from which ref, and when it was made. */
interface CheckedOut {
  sha: string;
  ref: string;
  committedAt: string | null;
}

/** What detection decided, and the catalog manifest the packer gets. */
interface Detected {
  manifest: CatalogManifest;
  version: string;
  detection: RepositoryDetection;
  /** No `package.json`: nothing to install. */
  installs: boolean;
}

/** An ISO 8601 date git printed, or null. */
function isoOrNull(text: string): string | null {
  const value = text.trim();
  return z.iso.datetime({ offset: true }).safeParse(value).success ? value : null;
}

/** A repository build's dependencies: a sandbox build's, plus the GitHub access tokens this Worker holds. */
export interface RepositoryBuildDeps extends BuildDeps {
  /** The value of a GitHub access token secret, or null when this Worker does not hold it. */
  githubToken?: (secretName: string) => string | null;
}

class RepositorySteps extends CommandRunner<BuildStage> {
  /** The environment of the commands that fetch from GitHub; with a token, it carries it. */
  private readonly fetchEnv: Readonly<Record<string, string>>;

  constructor(
    sandbox: BuildSandbox,
    log: BuildLog,
    private readonly request: RepositoryBuildRequest,
    private readonly now: () => number,
    /** The GitHub access token of a private repository; null for a public one. */
    private readonly token: string | null,
  ) {
    super(sandbox, log);
    this.fetchEnv = token === null ? BUILD_ENV : { ...BUILD_ENV, ...gitTokenEnv(token) };
  }

  private async git(args: string): Promise<string> {
    const result = await this.run("checkout", `git -C ${shellQuote(SOURCE_DIR)} ${args}`, {
      timeoutMs: STAGE_TIMEOUTS.quick,
      quiet: true,
    });
    return result.stdout.trim();
  }

  /** Why a fetch from the repository failed, as far as the build can tell. */
  private fetchFailure(what: string): string {
    return this.token === null
      ? `${what} could not be fetched from ${this.request.repo}; it may not exist there, or the repository is not public`
      : `${what} could not be fetched from ${this.request.repo} with the GitHub access token; it may not exist there, or the token cannot read the repository (it may have expired)`;
  }

  /**
   * Fetches `revision` (a commit, a branch or tag name, or `HEAD` for the
   * default branch) at depth 1 and checks it out, detached. `fresh` starts
   * a new repository in the source directory first.
   */
  private async fetchRevision(revision: string, fresh: boolean): Promise<void> {
    const src = shellQuote(SOURCE_DIR);
    const init = fresh
      ? [
          `rm -rf ${src}`,
          `git init -q ${src}`,
          `git -C ${src} remote add origin ${shellQuote(cloneUrl(this.request.repo))}`,
        ]
      : [];
    await this.run(
      "checkout",
      [
        ...init,
        `git -C ${src} fetch -q --depth 1 origin ${shellQuote(revision)}`,
        `git -C ${src} checkout -q --detach FETCH_HEAD`,
      ].join(" && "),
      {
        timeoutMs: STAGE_TIMEOUTS.checkout,
        env: this.fetchEnv,
        failure: this.fetchFailure(
          isCommitSha(revision)
            ? `the commit ${revision}`
            : revision === "HEAD"
              ? "the default branch"
              : revision,
        ),
      },
    );
  }

  async checkout(): Promise<CheckedOut> {
    const { repo, ref, commit } = this.request;
    const byCommit = ref !== undefined && isCommitSha(ref) ? ref : undefined;
    await this.log.stage(
      "checkout",
      `Checking out ${repo} at ${ref ?? "its default branch"}${commit !== undefined && commit !== ref ? ` (${commit})` : ""}`,
    );
    if (this.token !== null) {
      this.note("The repository is read with a GitHub access token this Worker holds.");
    }
    await this.run(
      "checkout",
      `rm -rf ${shellQuote(WORK_ROOT)} && mkdir -p ${shellQuote(WORK_ROOT)}`,
      { timeoutMs: STAGE_TIMEOUTS.quick },
    );
    if (byCommit !== undefined) {
      await this.fetchRevision(byCommit, true);
    } else if (this.token !== null) {
      // With a token, git fetches (the Sandbox SDK's clone takes no
      // environment): the commit the caller resolved, else the ref itself.
      await this.fetchRevision(commit ?? ref ?? "HEAD", true);
    } else {
      try {
        await this.sandbox.gitCheckout(cloneUrl(repo), {
          ...(ref === undefined ? {} : { branch: ref }),
          targetDir: SOURCE_DIR,
          depth: 1,
          cloneTimeoutMs: STAGE_TIMEOUTS.checkout,
        });
      } catch (error) {
        throw new StepError<BuildStage>(
          "checkout",
          `${repo} could not be cloned${ref === undefined ? "" : ` at ${ref}`}: it may not exist, may not be public, or has no branch or tag by that name (${messageOf(error)})`,
          null,
          false,
        );
      }
    }
    let sha = await this.git("rev-parse HEAD");
    if (commit !== undefined && sha !== commit) {
      this.note(
        `${ref ?? "The default branch"} is at ${sha || "no commit"}, not ${commit}; fetching ${commit}.`,
      );
      await this.fetchRevision(commit, false);
      sha = await this.git("rev-parse HEAD");
      if (sha !== commit) {
        throw new StepError<BuildStage>(
          "checkout",
          `the checkout is at ${sha || "no commit"}, not ${commit}`,
          null,
          false,
        );
      }
    }
    if (!isCommitSha(sha)) {
      throw new StepError<BuildStage>(
        "checkout",
        "git did not report the commit it checked out",
        null,
        false,
      );
    }
    const name =
      ref ?? (byCommit === undefined ? await this.git("rev-parse --abbrev-ref HEAD") : sha);
    const committedAt = isoOrNull(await this.git("log -1 --format=%cI HEAD"));
    this.note(`HEAD is ${sha}${name === sha ? "" : ` (${name})`}.`);
    return { sha, ref: name.length > 0 && name !== "HEAD" ? name : sha, committedAt };
  }

  /** The contents of a file at the root of the checkout, or null when it is not there. */
  private async read(file: string): Promise<string | null> {
    const result = await this.run(
      "detect",
      `head -c ${DETECTION_READ_LIMIT} -- ${shellQuote(`${SOURCE_DIR}/${file}`)}`,
      { timeoutMs: STAGE_TIMEOUTS.quick, quiet: true, failure: `reading ${file} failed` },
    );
    return result.stdout;
  }

  /**
   * The wrangler config's name, plain vars and the sections the packer
   * leaves out, as wrangler resolves it (JSON, JSONC or TOML alike).
   */
  private async inspect(wranglerConfig: string): Promise<WranglerFacts> {
    const result = await this.run("detect", commandLine(inspectArgv(SOURCE_DIR, wranglerConfig)), {
      cwd: SOURCE_DIR,
      timeoutMs: STAGE_TIMEOUTS.quick,
      quiet: true,
      failure: `wrangler could not read ${wranglerConfig}`,
    });
    const facts = parseInspectOutput(result.stdout);
    if (facts === null) {
      throw new DetectionError(`appflare-pack inspect gave no answer for ${wranglerConfig}`);
    }
    return facts;
  }

  async detect(checkedOut: CheckedOut): Promise<Detected> {
    const { request } = this;
    const baseline = request.baseline;
    await this.log.stage("detect", "Working out how to build it");
    const listing = await this.run("detect", `ls -1A -- ${shellQuote(SOURCE_DIR)}`, {
      timeoutMs: STAGE_TIMEOUTS.quick,
      quiet: true,
      failure: "listing the checkout failed",
    });
    const files = new Set(
      listing.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    );
    const contents = new Map<string, string>();
    for (const file of DETECTION_FILES) {
      if (files.has(file)) contents.set(file, (await this.read(file)) ?? "");
    }
    try {
      const pkg: PackageFacts | null = readPackageFacts(contents.get("package.json") ?? null);
      const packageManager: PackageManager =
        baseline?.install.packageManager ?? (pkg === null ? "npm" : detectPackageManager(files));
      const wranglerConfig = baseline?.install.wranglerConfig ?? detectWranglerConfig(files);
      const wrangler = await this.inspect(wranglerConfig);
      const choice: BuildCommandChoice = request.buildCommand ?? { mode: "detect" };
      const build = chooseBuildCommand(choice, packageManager, pkg, baseline?.install.buildCommand);
      const version = artifactVersion({
        ref: checkedOut.ref,
        sha: checkedOut.sha,
        committedAt: checkedOut.committedAt,
        now: this.now(),
        avoid: request.avoidVersions ?? [],
      });
      const secretsFrom = baseline === undefined ? secretsFile(files) : null;
      const drafted =
        baseline === undefined
          ? repositoryManifest({
              repo: request.repo,
              ref: checkedOut.ref,
              sha: checkedOut.sha,
              version,
              packageManager,
              wranglerConfig,
              wrangler,
              pkg,
              buildCommand: build.command,
              secrets:
                secretsFrom === null
                  ? []
                  : parseSecretsExample(contents.get(secretsFrom) ?? "", wrangler.vars),
            })
          : sourceBuildManifest(baseline, {
              ref: checkedOut.ref,
              sha: checkedOut.sha,
              version,
              buildCommand: build.command,
            });
      const parsed = catalogManifestSchema.safeParse(drafted);
      if (!parsed.success) {
        throw new DetectionError(
          `the catalog manifest worked out for it is not valid: ${z.prettifyError(parsed.error).replace(/\s+/g, " ")}`,
        );
      }
      const detection: RepositoryDetection = {
        packageManager,
        wranglerConfig,
        // Shown to the admin; a catalog app's list of commands on one line.
        buildCommand: build.command === null ? null : buildCommandText(build.command),
        buildCommandFrom: build.from,
        secretsFrom: secretsSource(secretsFrom, baseline !== undefined),
        unsupported: wrangler.unsupported,
      };
      this.note(
        [
          `Package manager: ${packageManager}${baseline === undefined ? (pkg === null ? " (no package.json, nothing to install)" : " (from the lockfile)") : " (from the catalog)"}.`,
          `Wrangler config: ${wranglerConfig}.`,
          `Build command: ${build.command ?? "none"}${build.from === "none" ? "" : ` (${build.from})`}.`,
          `Secrets: ${parsed.data.secrets.map((s) => s.name).join(", ") || "none"}${detection.secretsFrom === "none" ? "" : ` (from ${detection.secretsFrom})`}.`,
          `Version: ${version}.`,
          ...(wrangler.unsupported.length > 0
            ? [
                `The wrangler config uses ${wrangler.unsupported.join(", ")}, which Appflare cannot install yet.`,
              ]
            : []),
        ].join("\n"),
      );
      return { manifest: parsed.data, version, detection, installs: pkg !== null };
    } catch (error) {
      if (error instanceof DetectionError) {
        throw new StepError<BuildStage>("detect", error.message, null, false);
      }
      throw error;
    }
  }
}

/** Runs one build from a repository. Never throws. */
export async function runRepositoryBuild(
  input: unknown,
  deps: RepositoryBuildDeps,
): Promise<RepositoryBuildOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const common = { protocol: SANDBOX_PROTOCOL_VERSION, sandboxVersion: deps.sandboxVersion };

  const parsed = repositoryBuildRequestSchema.safeParse(input);
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
  const logKey = buildKeys(request.installId, request.runId, "_").log;
  const instanceType = request.instanceType ?? DEFAULT_SANDBOX_INSTANCE_TYPE;
  const image = sandboxImage(deps.sandboxVersion);
  const log = new BuildLog({
    bucket: deps.bucket,
    key: logKey,
    now,
    flushIntervalMs: deps.flushIntervalMs ?? LOG_FLUSH_INTERVAL_MS,
  });
  log.line(
    `Building ${request.baseline === undefined ? request.repo : `${request.baseline.name} from source`} ` +
      `in ${image} (${instanceType}).`,
  );

  let stage: BuildStage = "checkout";
  let sandbox: BuildSandbox | null = null;
  let outcome: RepositoryBuildOutcome;
  try {
    let token: string | null = null;
    if (request.tokenSecret !== undefined) {
      token = deps.githubToken?.(request.tokenSecret) ?? null;
      if (token === null) {
        throw new StepError<BuildStage>(
          "checkout",
          `the sandbox Worker does not hold the GitHub access token ${request.tokenSecret}: if it was just added, try again in a minute; otherwise delete it in Settings > Account and capabilities > GitHub access, and add it again`,
          null,
          false,
        );
      }
      log.redact(tokenRedactions(token));
    }
    sandbox = restartOnRuntimeUpdate(
      (id) => deps.openSandbox(id, instanceType),
      await repositorySandboxId(request.installId, request.attempt ?? 1),
      (reason) => log.line(restartNote(reason)),
    );
    const repository = new RepositorySteps(sandbox, log, request, now, token);
    const checkedOut = await repository.checkout();
    stage = "detect";
    const detected = await repository.detect(checkedOut);
    const target: PackTarget = {
      repo: request.repo,
      sha: checkedOut.sha,
      version: detected.version,
      catalogManifest: detected.manifest,
    };
    const keys = buildKeys(request.installId, detected.version, detected.manifest.slug);
    const steps = new BuildSteps(sandbox, log, target, keys, deps.bucket);
    stage = "install";
    if (detected.installs) {
      await steps.install();
    } else {
      log.line("There is no package.json, so there are no dependencies to install.");
    }
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
      logKey,
      log: "",
      image,
      installId: request.installId,
      version: detected.version,
      digest,
      size: packed.zipSize,
      manifestKey: keys.manifest,
      artifactKey: keys.artifact,
      commit: checkedOut.sha,
      ref: checkedOut.ref,
      committedAt: checkedOut.committedAt,
      detected: detected.detection,
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
      logKey,
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
    // The log is progress only; the outcome carries the same tail.
  }
  return { ...outcome, minutes, log: log.text };
}
