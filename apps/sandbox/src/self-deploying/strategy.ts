import type { SelfManagedStep } from "@appflare/schema";
import type { AccountReader, OwnedResourceNames } from "../discover";
import type { BuildLog } from "../log";
import type { ContainerSteps } from "../steps";

/**
 * How one installer tool runs inside a self-deploying run (self-managed.ts).
 * The run itself is the same for every tool: read the app's token and
 * secrets, check the pin out, install, build, run the installer, read back
 * what it left in the account. A strategy fills in only what differs: what
 * the tool needs before the container starts, the words its commands run
 * behind, which of its commands run for a deploy or a destroy, and what
 * else in the account is named after the install.
 */

export type SelfManagedAction = "deploy" | "destroy";

/** What a strategy works with, beyond its request. */
export interface StrategyDeps {
  bucket: R2Bucket;
  log: BuildLog;
  /** The app token, already redacted from the log. */
  token: string;
  /** Reads the account with the app token. */
  account: () => AccountReader;
}

/** One run of the installer's action in the prepared container. */
export interface InstallerRunContext {
  action: SelfManagedAction;
  container: ContainerSteps<SelfManagedStep>;
  /**
   * The installer's environment: the build environment, the app's settings
   * and secrets, the account id and the app token under the tool's names.
   */
  env: Readonly<Record<string, string>>;
}

export interface InstallerStrategy {
  /**
   * Words every command of the run (dependency install, build, installer)
   * runs behind, such as the launcher that puts Node 24 first on PATH.
   */
  readonly launcher: readonly string[];
  /**
   * The exact names of what the installer creates for the install, by kind,
   * which discovery looks up and limits itself to (see `discover`); null
   * for a tool whose Workers' bindings are the whole record.
   */
  readonly ownedResources: OwnedResourceNames | null;
  /**
   * Runs in the run's token step, before any container starts: reads what
   * the tool needs from the account with the app token. Throws a
   * `StepError` of the token step.
   */
  prepare(): Promise<void>;
  /** Runs the installer for the action. Throws a `StepError` of the action's step. */
  run(context: InstallerRunContext): Promise<void>;
}
