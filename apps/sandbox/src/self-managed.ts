import {
  appSecretSecretName,
  appTokenSecretName,
  buildKeys,
  DEFAULT_SANDBOX_INSTANCE_TYPE,
  SANDBOX_PROTOCOL_VERSION,
  type SandboxInstanceType,
  type SelfManagedFailure,
  type SelfManagedOutcome,
  type SelfManagedRunRequest,
  type SelfManagedStatus,
  type SelfManagedStep,
  sandboxImage,
  selfManagedRunRequestSchema,
  selfManagedStatusRequestSchema,
} from "@appflare/schema";
import { z } from "zod";
import { type AccountReader, discover } from "./discover";
import { BuildLog } from "./log";
import {
  BUILD_ENV,
  commandLine,
  LOG_FLUSH_INTERVAL_MS,
  minutesBetween,
  SOURCE_DIR,
  STAGE_TIMEOUTS,
  selfManagedSandboxId,
  shellQuote,
} from "./protocol";
import { restartNote, restartOnRuntimeUpdate } from "./restart";
import type { BuildSandbox } from "./sandbox";
import { ContainerSteps, messageOf, StepError } from "./steps";

/**
 * One run of a self-deploying app's own installer, start to finish:
 *
 * 1. token: read the app's token (and its secret values) that the manager
 *    stored as secrets on this Worker for the install. Nothing secret
 *    arrives in the request.
 * 2. checkout and install: the pinned commit, dependencies installed with
 *    install scripts disabled (as for a build).
 * 3. build: the entry's `install.buildCommand`, if any, in the same
 *    credential-free environment as a build.
 * 4. deploy (or destroy): any `.env` in the project or at the checkout root
 *    is deleted first (installers such as Alchemy read it before the
 *    environment), then the installer's command with `<stageArg> <stage>`
 *    appended, in the build environment plus the app's settings, its
 *    secrets, the account id and the app token under the names the tool
 *    reads. This is the only command that sees a credential, and the only
 *    credential it sees is the app's own. Known secret values are redacted
 *    from the log.
 * 5. discover: read the expected Workers and what they bind back from the
 *    account with the app token. After a destroy, only which Workers remain.
 *
 * A new version of this Worker (each secret the manager stores here deploys
 * one) that resets the container before its first command went through sends
 * the run to a fresh container once (restart.ts). The container is destroyed
 * at the end whatever happened. Failures come back as a
 * {@link SelfManagedFailure} naming the step, never as a thrown error.
 */

export type SelfManagedAction = "deploy" | "destroy";

/** What the sandbox Worker holds for an install, read from its own secrets. */
export interface HeldCredentials {
  token: string | null;
  /** The values of the requested app secrets it holds, by name (absent ones missing). */
  secrets: Record<string, string>;
}

export interface SelfManagedDeps {
  bucket: R2Bucket;
  sandboxVersion: string;
  openSandbox(id: string, instanceType: SandboxInstanceType): BuildSandbox;
  credentials(installId: string, secretNames: readonly string[]): HeldCredentials;
  /** Reads the account with the app's token. */
  account(token: string, accountId: string): AccountReader;
  now?: () => number;
  flushIntervalMs?: number;
}

/**
 * Reads an install's token and the named app secrets from the sandbox
 * Worker's environment. The names are per install (`APP_TOKEN_<installId>`,
 * `APP_SECRET_<installId>_<name>`), so they are not declared on `Env`;
 * secrets arrive as plain strings.
 */
export function heldCredentials(
  env: object,
  installId: string,
  secretNames: readonly string[],
): HeldCredentials {
  const vars = env as Record<string, unknown>;
  const token = vars[appTokenSecretName(installId)];
  const secrets: Record<string, string> = {};
  for (const name of secretNames) {
    const value = vars[appSecretSecretName(installId, name)];
    if (typeof value === "string" && value.length > 0) secrets[name] = value;
  }
  return { token: typeof token === "string" && token.length > 0 ? token : null, secrets };
}

/** The environment of the installer command. */
export function installerEnv(
  request: SelfManagedRunRequest,
  token: string,
  secrets: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = { ...BUILD_ENV, ...request.vars };
  for (const name of request.secretNames) {
    const value = secrets[name];
    if (value !== undefined) env[name] = value;
  }
  for (const name of request.accountIdEnv) env[name] = request.accountId;
  for (const name of request.tokenEnv) env[name] = token;
  return env;
}

/**
 * Deletes `.env` in the project and at the checkout root, and says so in the
 * log when there was one.
 */
async function removeDotEnv(
  container: ContainerSteps<SelfManagedStep>,
  step: SelfManagedAction,
  atRoot: boolean,
): Promise<void> {
  const files = [`${container.project}/.env`, ...(atRoot ? [] : [`${SOURCE_DIR}/.env`])].map(
    shellQuote,
  );
  const removed = await container.run(
    step,
    files
      .map((f) => `if [ -e ${f} ] || [ -L ${f} ]; then rm -rf -- ${f} && echo ${f}; fi`)
      .join("; "),
    { timeoutMs: STAGE_TIMEOUTS.quick, quiet: true },
  );
  for (const line of removed.stdout.split("\n").filter((l) => l.trim().length > 0)) {
    container.note(
      `Removed ${line.trim()}: the installer gets its settings from Appflare, not from a .env file.`,
    );
  }
}

/** The installer's command line with the stage appended. */
export function installerCommand(request: SelfManagedRunRequest): string {
  return commandLine([...request.command, request.stageArg, request.stage]);
}

type RunError = StepError<SelfManagedStep>;

function failure(step: SelfManagedStep, message: string, retryable = false): RunError {
  return new StepError<SelfManagedStep>(step, message, null, retryable);
}

/** Runs the installer's deploy or destroy command. Never throws. */
export async function runSelfManaged(
  action: SelfManagedAction,
  input: unknown,
  deps: SelfManagedDeps,
): Promise<SelfManagedOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const common = { protocol: SANDBOX_PROTOCOL_VERSION, sandboxVersion: deps.sandboxVersion };

  const parsed = selfManagedRunRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      action,
      ...common,
      minutes: 0,
      logKey: null,
      log: "",
      step: "request",
      message: `the ${action} request is not valid:\n${z.prettifyError(parsed.error)}`,
      retryable: false,
      exitCode: null,
    };
  }
  const request = parsed.data;
  const { installId } = request;
  const logKey = buildKeys(installId, request.runId, "_").log;
  const instanceType = request.instanceType ?? DEFAULT_SANDBOX_INSTANCE_TYPE;
  const image = sandboxImage(deps.sandboxVersion);
  const log = new BuildLog({
    bucket: deps.bucket,
    key: logKey,
    now,
    flushIntervalMs: deps.flushIntervalMs ?? LOG_FLUSH_INTERVAL_MS,
  });
  const verb = action === "deploy" ? "Deploying" : "Destroying";
  log.line(
    `${verb} ${request.repo}@${request.sha} (stage ${request.stage}) with its own installer ` +
      `(${request.tool}) in ${image} (${instanceType}).`,
  );

  let step: SelfManagedStep = "token";
  let sandbox: BuildSandbox | null = null;
  let outcome: SelfManagedOutcome;
  try {
    await log.stage("token", "Reading the app token this Worker holds for the install");
    const held = deps.credentials(installId, request.secretNames);
    if (held.token === null) {
      throw failure(
        "token",
        `this sandbox Worker holds no app token for the install (secret ${appTokenSecretName(installId)}); enter the app's token again in Appflare`,
      );
    }
    const secrets = held.secrets;
    const absent = request.secretNames.filter((name) => secrets[name] === undefined);
    if (absent.length > 0) {
      throw failure(
        "token",
        `this sandbox Worker holds no value for ${absent.join(", ")}; enter the app's secrets again in Appflare`,
      );
    }
    const token = held.token;
    log.redact([token, ...request.secretNames.map((n) => secrets[n] ?? "")]);
    log.line("The app token and secrets are here; they reach only the installer's command.");

    sandbox = restartOnRuntimeUpdate(
      (id) => deps.openSandbox(id, instanceType),
      await selfManagedSandboxId(installId, request.attempt ?? 1),
      (reason) => log.line(restartNote(reason)),
    );
    const container = new ContainerSteps<SelfManagedStep>(
      sandbox,
      log,
      {
        repo: request.repo,
        sha: request.sha,
        ref: request.ref,
        subdirectory: request.subdirectory,
        packageManager: request.packageManager,
      },
      { checkout: "checkout", install: "install" },
    );
    step = "checkout";
    await container.checkout();
    step = "install";
    await container.install();

    if (request.buildCommand !== undefined) {
      step = "build";
      await log.stage("build", "Building the app, without credentials");
      await container.run("build", commandLine(request.buildCommand), {
        cwd: container.project,
        timeoutMs: STAGE_TIMEOUTS.build,
        failure: `the build command \`${request.buildCommand.join(" ")}\` failed`,
      });
    }

    // Alchemy (and dotenv-style tools) read a `.env` in the working directory
    // before the environment. One from the repository or written by the build
    // would override what Appflare hands the installer, so none may exist.
    step = action;
    await removeDotEnv(container, action, request.subdirectory === undefined);
    await log.stage(
      action,
      `Running the installer's ${action} command with the app's token (${request.tokenEnv.join(", ")})`,
    );
    await container.run(action, installerCommand(request), {
      cwd: container.project,
      timeoutMs: STAGE_TIMEOUTS.installer,
      env: installerEnv(request, token, secrets),
      failure: `the installer's ${action} command failed`,
    });

    step = "discover";
    await log.stage("discover", "Reading what the installer left in the account");
    let found: Awaited<ReturnType<typeof discover>>;
    try {
      found = await discover(deps.account(token, request.accountId), request.expectedWorkers, {
        withResources: action === "deploy",
      });
    } catch (error) {
      throw failure(
        "discover",
        `the account could not be read with the app token: ${log.scrub(messageOf(error))}`,
        true,
      );
    }
    if (action === "deploy") {
      if (found.missing.length > 0) {
        throw failure(
          "discover",
          `the installer finished, but the account has no Worker ${found.missing.join(", ")}; the catalog entry's selfDeploying.workers does not match what it deploys`,
        );
      }
      for (const r of found.resources) log.line(`Found ${r.kind} ${r.name} (${r.worker}).`);
      outcome = {
        ok: true,
        action: "deploy",
        ...common,
        minutes: 0,
        logKey,
        log: "",
        image,
        installId,
        workers: found.workers,
        resources: found.resources,
      };
    } else {
      const remaining = found.workers.map((w) => w.name);
      log.line(
        remaining.length === 0
          ? "None of the app's Workers remain."
          : `Still in the account: ${remaining.join(", ")}.`,
      );
      outcome = {
        ok: true,
        action: "destroy",
        ...common,
        minutes: 0,
        logKey,
        log: "",
        image,
        installId,
        remaining,
      };
    }
  } catch (error) {
    const failed: RunError =
      error instanceof StepError
        ? (error as RunError)
        : failure(step, `the run stopped unexpectedly: ${log.scrub(messageOf(error))}`, true);
    log.line(`\nFAILED (${failed.step}): ${failed.message}`);
    outcome = {
      ok: false,
      action,
      ...common,
      minutes: 0,
      logKey,
      log: "",
      step: failed.step,
      message: failed.message,
      retryable: failed.retryable,
      exitCode: failed.exitCode,
    };
  }

  if (sandbox !== null) {
    try {
      await sandbox.destroy();
    } catch (error) {
      log.line(`Stopping the container failed: ${log.scrub(messageOf(error))}`);
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

/** What the sandbox Worker holds for an install, and which of its Workers exist. */
export async function selfManagedStatus(
  input: unknown,
  deps: Pick<SelfManagedDeps, "sandboxVersion" | "credentials" | "account">,
): Promise<SelfManagedStatus> {
  const request = selfManagedStatusRequestSchema.parse(input);
  const held = deps.credentials(request.installId, request.secretNames);
  const base = {
    protocol: SANDBOX_PROTOCOL_VERSION,
    sandboxVersion: deps.sandboxVersion,
    tokenPresent: held.token !== null,
    secretsPresent: request.secretNames.every((n) => held.secrets[n] !== undefined),
  };
  if (held.token === null) {
    return { ...base, workers: null, problem: "this sandbox Worker holds no app token for it" };
  }
  try {
    const found = await discover(
      deps.account(held.token, request.accountId),
      request.expectedWorkers,
      { withResources: false },
    );
    return { ...base, workers: found.workers, problem: null };
  } catch (error) {
    const message = messageOf(error).replaceAll(held.token, "[redacted]");
    return {
      ...base,
      workers: null,
      problem: `the account could not be read with the app token: ${message}`,
    };
  }
}
