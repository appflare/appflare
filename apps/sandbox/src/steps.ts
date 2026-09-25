import type { PackageManager, RunStep } from "@appflare/schema";
import type { BuildLog } from "./log";
import {
  BUILD_ENV,
  cloneUrl,
  commandLine,
  installArgv,
  SOURCE_DIR,
  STAGE_TIMEOUTS,
  shellQuote,
  tailLines,
  WORK_ROOT,
} from "./protocol";
import type { BuildSandbox, ExecOutcome } from "./sandbox";

/**
 * What every run in a container starts with, a sandbox build and a
 * self-deploying run alike: a clean work directory, the pinned commit
 * checked out (a tag can move; the SHA cannot), and the dependencies
 * installed with install scripts disabled. Commands run one at a time; their
 * output streams into the run's log.
 */

/** A failed step. `retryable` when the container could not run the command at all. */
export class StepError<S extends string> extends Error {
  constructor(
    readonly step: S,
    message: string,
    readonly exitCode: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "StepError";
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The pinned source of a run. */
export interface RunSource {
  repo: string;
  sha: string;
  /** The pin's branch or tag, tried first for a shallow clone. */
  ref: string;
  subdirectory?: string | undefined;
  packageManager: PackageManager;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs: number;
  /** What the failure message says failed, instead of the command line. */
  failure?: string;
  /** Neither the command nor its output goes to the log. */
  quiet?: boolean;
  /** Replaces the credential-free build environment for this command. */
  env?: Readonly<Record<string, string>>;
  /** Shown in the log instead of the command line (which may name values). */
  shownAs?: string;
}

/**
 * Runs commands in a run's container, one at a time; their output streams
 * into the run's log.
 */
export class CommandRunner<S extends RunStep> {
  constructor(
    protected readonly sandbox: BuildSandbox,
    protected readonly log: BuildLog,
  ) {}

  /** Adds one line of narration to the run's log. */
  note(message: string): void {
    this.log.line(message);
  }

  /**
   * Runs one command line; its output streams into the log. A command that
   * cannot be run at all (the container did not start or went away) is
   * retryable; one that exits non-zero is not.
   */
  async run(step: S, command: string, options: RunOptions): Promise<ExecOutcome> {
    if (!options.quiet) this.log.line(`$ ${options.shownAs ?? command}`);
    let output = "";
    let result: ExecOutcome;
    try {
      result = await this.sandbox.exec(command, {
        cwd: options.cwd,
        env: options.env ?? BUILD_ENV,
        timeoutMs: options.timeoutMs,
        onOutput: (chunk) => {
          output = (output + chunk).slice(-64 * 1024);
          if (!options.quiet) this.log.append(chunk);
        },
      });
    } catch (error) {
      throw new StepError(
        step,
        `the container could not run \`${options.shownAs ?? command}\`: ${this.log.scrub(messageOf(error))}`,
        null,
        true,
      );
    }
    if (result.exitCode !== 0) {
      const tail = this.log.scrub(tailLines(output || `${result.stdout}\n${result.stderr}`));
      throw new StepError(
        step,
        `${options.failure ?? `\`${options.shownAs ?? command}\` failed`} (exit code ${result.exitCode})${tail ? `:\n${tail}` : ""}`,
        result.exitCode,
        false,
      );
    }
    return result;
  }
}

export class ContainerSteps<S extends RunStep> extends CommandRunner<S> {
  constructor(
    sandbox: BuildSandbox,
    log: BuildLog,
    private readonly source: RunSource,
    /** The step names this run reports its checkout and install as. */
    private readonly steps: { checkout: S; install: S },
  ) {
    super(sandbox, log);
  }

  /** The project inside the checkout. */
  get project(): string {
    return this.source.subdirectory ? `${SOURCE_DIR}/${this.source.subdirectory}` : SOURCE_DIR;
  }

  private async head(): Promise<string> {
    const result = await this.run(
      this.steps.checkout,
      `git -C ${shellQuote(SOURCE_DIR)} rev-parse HEAD`,
      { timeoutMs: STAGE_TIMEOUTS.quick, quiet: true },
    );
    return result.stdout.trim();
  }

  /**
   * A clean work directory and the pinned commit: a shallow clone of the
   * pin's ref, and when the ref has moved (or is not a branch or tag), a
   * fetch of the pinned commit itself.
   */
  async checkout(): Promise<void> {
    const { repo, sha, ref } = this.source;
    const step = this.steps.checkout;
    await this.log.stage(step, `Checking out ${repo} at ${sha} (${ref})`);
    await this.run(step, `rm -rf ${shellQuote(WORK_ROOT)} && mkdir -p ${shellQuote(WORK_ROOT)}`, {
      timeoutMs: STAGE_TIMEOUTS.quick,
    });

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
        step,
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
      throw new StepError(
        step,
        `the checkout is at ${head || "no commit"}, not the pinned ${sha}`,
        null,
        false,
      );
    }
    this.log.line(`HEAD is ${sha}.`);
    if (this.source.subdirectory) {
      await this.run(step, `test -d ${shellQuote(this.project)}`, {
        timeoutMs: STAGE_TIMEOUTS.quick,
        failure: `the subdirectory ${this.source.subdirectory} does not exist at ${sha}`,
      });
    }
  }

  /**
   * The package manager's frozen install with install scripts disabled: the
   * same argv the packer uses for a checkout.
   */
  async install(): Promise<void> {
    const { packageManager } = this.source;
    const step = this.steps.install;
    await this.log.stage(step, `Installing dependencies with ${packageManager}, scripts disabled`);
    await this.run(step, commandLine(installArgv(packageManager)), {
      cwd: this.project,
      timeoutMs: STAGE_TIMEOUTS.install,
      failure: "installing the dependencies failed",
    });
  }
}
