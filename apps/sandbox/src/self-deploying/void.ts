import { CloudflareApiError } from "@appflare/cf-api";
import {
  fillSelfDeployingCommand,
  type SelfManagedStep,
  type VoidRunCommand,
  type VoidRunRequest,
} from "@appflare/schema";
import type { OwnedResourceNames } from "../discover";
import { commandLine, NODE_24_LAUNCHER, STAGE_TIMEOUTS, WORK_ROOT } from "../protocol";
import { type ContainerSteps, messageOf, StepError } from "../steps";
import type { InstallerStrategy, StrategyDeps } from "./strategy";
import {
  captureVoidRegistry,
  EMPTY_REGISTRY,
  findVoidRecord,
  forgetVoidRegistry,
  loadVoidRegistry,
  restoreVoidRegistry,
  storeVoidRegistry,
  VOID_REGISTRY_DIR,
  type VoidRecord,
  type VoidRegistrySnapshot,
} from "./void-registry";

/**
 * The Void CLI (`void platform ...`, Node 24): the entry lists a command for
 * each thing a run may need (discover, install, resume, update, destroy),
 * with `{{stage}}` and `{{accountId}}` in their words, and this strategy
 * picks which runs, from the installation's record in the Void registry
 * (void-registry.ts), never from the CLI's output:
 *
 * - deploy: no record of the installation (none saved, and the discover
 *   command found none in the account) runs the install command; a first
 *   install that stopped part way runs the resume command; an installation
 *   that was deployed once (it has a runtime) runs the update command, also
 *   when an update of it stopped part way or failed (see
 *   {@link chooseVoidDeployCommand}). Afterwards the installation must be
 *   `installed`: Void exits 0 when it stops to wait for DNS or for
 *   sandboxes to drain.
 * - destroy: the destroy command, when there is an installation; afterwards
 *   the registry must record it uninstalled (or not at all), and only then
 *   is the saved registry deleted.
 *
 * Every command runs exactly as its filled-in argv, behind the launcher that
 * puts Node 24 first on PATH, with a fresh HOME, the registry directory,
 * and R2 access keys derived from the app token (Void stores user apps'
 * assets in R2 and needs S3 keys; Cloudflare's R2 keys for an API token are
 * the token's id and the SHA-256 of its value). The registry is saved back
 * to the bucket after every command, even one that failed: what Void
 * recorded is what the next run continues from.
 */

/** The fresh home directory of the Void CLI's commands (the work directory is wiped before each run). */
export const VOID_HOME = `${WORK_ROOT}/home`;

/**
 * Where the image's corepack keeps the pnpm it prepared (the default for
 * root, `$HOME/.cache/node/corepack`, as the image build ran; the Dockerfile
 * checks it is there). The Void CLI's commands run with a HOME of their own,
 * so they are pointed back at it; nothing else changes where corepack looks.
 */
export const IMAGE_COREPACK_HOME = "/root/.cache/node/corepack";

/**
 * What the Void CLI creates for installation `stage`, by the exact names it
 * gives them: dispatch namespace `void-<stage>-users`, Hyperdrive
 * configuration `void-<stage>-database`, AI Gateway `void-<stage>`, KV
 * namespaces `-routing`, `-isr-cache` and `-legacy-assets`, R2 bucket
 * `-assets`, queues `-usage-events`, `-cron-fires` and `-deployments`.
 * Discovery records only these (besides the Workers and their Durable Object
 * classes and Workflows): what the platform later creates for its own users'
 * projects, also named `void-<stage>-...`, is theirs, not the install's.
 */
export function voidResourceNames(stage: string): OwnedResourceNames {
  const p = `void-${stage}`;
  return {
    dispatch_namespace: [`${p}-users`],
    hyperdrive: [`${p}-database`],
    ai_gateway: [p],
    kv: [`${p}-routing`, `${p}-isr-cache`, `${p}-legacy-assets`],
    r2: [`${p}-assets`],
    queue: [`${p}-usage-events`, `${p}-cron-fires`, `${p}-deployments`],
  };
}

/** Lowercase hex SHA-256 of `value`. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** S3 credentials for R2, derived from the app token. */
export interface VoidR2Keys {
  /** The API token's id. */
  accessKeyId: string;
  /** Lowercase hex SHA-256 of the token's value. */
  secretAccessKey: string;
}

/**
 * The environment of the Void CLI's commands: the installer's environment
 * plus what the sandbox Worker sets for Void itself.
 */
export function voidEnv(
  base: Readonly<Record<string, string>>,
  keys: VoidR2Keys,
): Record<string, string> {
  return {
    ...base,
    HOME: VOID_HOME,
    COREPACK_HOME: IMAGE_COREPACK_HOME,
    VOID_PLATFORM_REGISTRY_DIR: VOID_REGISTRY_DIR,
    VOID_PLATFORM_R2_ACCESS_KEY_ID: keys.accessKeyId,
    VOID_PLATFORM_R2_SECRET_ACCESS_KEY: keys.secretAccessKey,
  };
}

/**
 * Statuses an install or an update passes through before it is
 * `installed`, as the Void CLI's `isPlatformInstallInProgress` lists them
 * (an update goes through `provisioning` and `deploying` too), plus `failed`.
 */
const UNFINISHED = new Set([
  "planned",
  "provisioning",
  "waiting-for-dns",
  "waiting-for-oauth",
  "deploying",
  "verifying",
  "failed",
]);

/** Which command a deploy runs, and why; or why it cannot run one. */
export type VoidDeployChoice =
  | { command: Extract<VoidRunCommand, "install" | "resume" | "update">; reason: string }
  | { refused: string };

/**
 * The deploy's command for the installation's recorded state, as the Void
 * CLI itself decides:
 *
 * - none: install.
 * - `installed`, or a runtime was deployed (`runtime` set) and the status
 *   is unfinished (an update paused to drain sandboxes, or cut off mid-way), run
 *   the update command. The CLI answers `install --resume` for a deployed
 *   installation with "has already been deployed. Use repair or upgrade",
 *   and offers `upgrade` to continue a stopped update.
 * - no runtime: resume, when the CLI counts the install as in progress
 *   (`isPlatformInstallInProgress`: an unfinished status, `desiredState`
 *   `enabled`, no resource deleted), or the record is a `draft`. The CLI
 *   writes a new record only once it is `planned`, so a draft on disk is
 *   one it never got further with; `install` refuses a name a record
 *   already holds ("already exists"), while `install --resume` takes any
 *   record not uninstalled and without endpoints, and plans it again.
 * - anything else (turned off, an uninstall stopped part way, resources
 *   already deleted, a status this Worker does not know) is refused, saying
 *   why.
 */
export function chooseVoidDeployCommand(
  record: VoidRecord | null,
  stage: string,
): VoidDeployChoice {
  if (record === null) {
    return {
      command: "install",
      reason: `No Void installation named ${stage} yet: running the install command.`,
    };
  }
  const { status } = record;
  if (status === "disabled" || status === "disabling" || record.desiredState === "disabled") {
    return {
      refused: `the Void installation ${stage} is turned off (status "${status}"), and Appflare does not turn it back on; turn it on with \`void platform enable ${record.id}\`, then update again`,
    };
  }
  if (status === "uninstalling" || record.hasDeletedResources) {
    return {
      refused: `an uninstall of the Void installation ${stage} stopped part way (status "${status}"); uninstall the app in Appflare to finish it`,
    };
  }
  // An installed record always updates, with or without `runtime` (which
  // records of older CLI versions may lack).
  if (status === "installed" || (record.hasRuntime && UNFINISHED.has(status))) {
    return {
      command: "update",
      reason:
        status === "installed"
          ? `The Void installation ${stage} is installed: running the update command.`
          : `The last update of the Void installation ${stage} did not finish (status "${status}"): running the update command again.`,
    };
  }
  if (!record.hasRuntime && (status === "draft" || UNFINISHED.has(status))) {
    return {
      command: "resume",
      reason: `The install of the Void installation ${stage} did not finish (status "${status}"): running the resume command.`,
    };
  }
  return {
    refused: `the Void installation ${stage} is "${status}"${record.hasRuntime ? "" : " without a runtime"}, which this sandbox Worker does not know how to continue; update the sandbox Worker, then try again`,
  };
}

/** The app token's R2 keys; a `StepError` of the token step when its id cannot be read. */
export async function deriveVoidR2Keys(deps: StrategyDeps): Promise<VoidR2Keys> {
  let accessKeyId: string;
  try {
    accessKeyId = await deps.account().tokenId();
  } catch (error) {
    // Cloudflare refusing the token will refuse it again; anything else may pass.
    const refused = error instanceof CloudflareApiError && error.status < 500;
    throw new StepError<SelfManagedStep>(
      "token",
      `the app token's id could not be read from Cloudflare, and Void's R2 access key is derived from it: ${deps.log.scrub(messageOf(error))}`,
      null,
      !refused,
    );
  }
  return { accessKeyId, secretAccessKey: await sha256Hex(deps.token) };
}

export function voidStrategy(request: VoidRunRequest, deps: StrategyDeps): InstallerStrategy {
  const { installId, stage, accountId } = request;
  const { bucket, log } = deps;
  let keys: VoidR2Keys | null = null;

  /**
   * Runs one of the entry's commands, filled in, then saves the registry
   * whatever happened. A failure to save after a failed command is logged
   * and the command's failure is what the run reports.
   */
  async function runCommand(
    container: ContainerSteps<SelfManagedStep>,
    step: SelfManagedStep,
    name: VoidRunCommand,
    env: Readonly<Record<string, string>>,
    deadline: number,
  ): Promise<VoidRegistrySnapshot> {
    const argv = fillSelfDeployingCommand(request.commands[name], { stage, accountId });
    let failed: unknown = null;
    try {
      await container.run(step, commandLine([NODE_24_LAUNCHER, ...argv]), {
        cwd: container.project,
        timeoutMs: Math.max(1_000, deadline - Date.now()),
        env,
        failure: `the Void ${name} command failed`,
      });
    } catch (error) {
      failed = error;
    }
    let snapshot: VoidRegistrySnapshot;
    try {
      snapshot = await captureVoidRegistry(container, step);
      await storeVoidRegistry(bucket, installId, step, snapshot);
    } catch (error) {
      if (failed === null) throw error;
      log.line(
        `Saving the Void registry after the failed command did not work either: ${log.scrub(messageOf(error))}`,
      );
      throw failed;
    }
    if (failed !== null) {
      log.line("Saved the Void registry as the failed command left it, for the next run.");
      throw failed;
    }
    return snapshot;
  }

  return {
    launcher: [NODE_24_LAUNCHER],
    ownedResources: voidResourceNames(stage),

    async prepare() {
      keys = await deriveVoidR2Keys(deps);
      log.redact([keys.secretAccessKey]);
      log.line(
        "Derived Void's R2 access keys from the app token: the token's id, and the SHA-256 of its value.",
      );
    },

    async run({ action, container, env }) {
      if (keys === null) throw new StepError(action, "the run was not prepared", null, false);
      const step: SelfManagedStep = action;
      const deadline = Date.now() + STAGE_TIMEOUTS.installer;
      const commandEnv = voidEnv(env, keys);

      const saved = await loadVoidRegistry(bucket, installId, step);
      if (saved.problem !== null) {
        log.line(
          `The saved Void registry of this install cannot be read (${saved.problem}); starting from an empty one.`,
        );
      } else if (saved.snapshot !== null) {
        log.line(
          `Restoring the Void registry saved for this install (${Object.keys(saved.snapshot.files).length} files).`,
        );
      } else {
        log.line("No Void registry is saved for this install yet.");
      }
      await restoreVoidRegistry(container, step, saved.snapshot ?? EMPTY_REGISTRY, VOID_HOME);

      let record =
        saved.snapshot === null ? null : findVoidRecord(saved.snapshot, accountId, stage);
      if (record === null) {
        log.line(
          `The registry has no record of the Void installation ${stage}: running the discover command to read it from the account.`,
        );
        const discovered = await runCommand(container, step, "discover", commandEnv, deadline);
        record = findVoidRecord(discovered, accountId, stage);
        log.line(
          record === null
            ? `The account has no Void installation named ${stage}.`
            : `Found the Void installation ${stage} in the account (status "${record.status}").`,
        );
      } else {
        log.line(
          `The registry records the Void installation ${stage} (status "${record.status}").`,
        );
      }

      if (action === "destroy") {
        if (record === null) {
          log.line(
            `No Void installation named ${stage} exists, so there is nothing for the destroy command to remove.`,
          );
        } else {
          log.line(`Running the destroy command for the Void installation ${stage}.`);
          const left = findVoidRecord(
            await runCommand(container, step, "destroy", commandEnv, deadline),
            accountId,
            stage,
          );
          // Void ends an uninstall at `uninstalled`, which counts as no record.
          // Anything else keeps the saved registry for the next attempt.
          if (left !== null) {
            throw new StepError(
              step,
              `the Void destroy command finished, but the installation ${stage} is "${left.status}", not uninstalled; the saved registry is kept, so uninstalling again continues from there`,
              null,
              false,
            );
          }
          log.line(`The Void installation ${stage} is uninstalled.`);
        }
        await forgetVoidRegistry(bucket, installId, step);
        log.line("Deleted the Void registry saved for this install.");
        return;
      }

      const choice = chooseVoidDeployCommand(record, stage);
      if ("refused" in choice) throw new StepError(step, choice.refused, null, false);
      log.line(choice.reason);
      const after = findVoidRecord(
        await runCommand(container, step, choice.command, commandEnv, deadline),
        accountId,
        stage,
      );
      if (after === null) {
        throw new StepError(
          step,
          `the Void ${choice.command} command finished, but the registry has no record of the installation ${stage}`,
          null,
          false,
        );
      }
      if (after.status !== "installed") {
        throw new StepError(
          step,
          `the Void ${choice.command} command finished, but the installation ${stage} is "${after.status}", not installed. Void stops there without an error when it has to wait (for DNS, or for running sandboxes to drain); update the app again once it can continue`,
          null,
          false,
        );
      }
      log.line(`The Void installation ${stage} is installed.`);
    },
  };
}
