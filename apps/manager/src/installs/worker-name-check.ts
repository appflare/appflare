import { WORKER_NAME_HINT, WORKER_NAME_PATTERN } from "./install-input";

/**
 * The install form's live check of the Worker name, as the admin types: the
 * format rules first, locally; then whether the name is free, against the
 * Worker names taken in the account (`listTakenWorkerNames`, read once per
 * form). Only a hint: starting the install checks again. Client-safe.
 */

/** Worker names in use, as `listTakenWorkerNames` returns them. */
export interface TakenWorkerNames {
  /** Workers of apps installed here (any install that is not uninstalled). */
  installed: string[];
  /** Every Worker in the account; null when the account could not be read. */
  account: string[] | null;
}

export type WorkerNameCheck =
  | { state: "invalid"; message: string }
  | { state: "checking" }
  | { state: "free" }
  | { state: "taken"; message: string }
  /** The account could not be read, so only the format was checked. */
  | { state: "unknown" };

/** How long typing pauses before the name is checked. */
export const WORKER_NAME_CHECK_DELAY_MS = 400;

export const INSTALLED_NAME_MESSAGE = "An app installed here already uses this name.";
export const ACCOUNT_NAME_MESSAGE =
  "A Worker with this name already exists in this account. Choose another name.";

/** Why the name breaks the format rules, or null when it follows them. */
export function workerNameFormatProblem(name: string): string | null {
  if (name === "") return "Enter a name.";
  return WORKER_NAME_PATTERN.test(name) ? null : `Use ${WORKER_NAME_HINT}`;
}

/** The check of `name` against the names in use, or "unknown" when they could not be read. */
export function workerNameVerdict(name: string, taken: TakenWorkerNames | null): WorkerNameCheck {
  const problem = workerNameFormatProblem(name);
  if (problem !== null) return { state: "invalid", message: problem };
  if (taken === null) return { state: "unknown" };
  if (taken.installed.includes(name)) return { state: "taken", message: INSTALLED_NAME_MESSAGE };
  if (taken.account === null) return { state: "unknown" };
  if (taken.account.includes(name)) return { state: "taken", message: ACCOUNT_NAME_MESSAGE };
  return { state: "free" };
}

/** Whether the install may start with this check: not while the name is invalid or taken. */
export function workerNameAllowsInstall(check: WorkerNameCheck): boolean {
  return check.state !== "invalid" && check.state !== "taken";
}
