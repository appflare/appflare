import type { CloudflareClient } from "@appflare/cf-api";
import { RECOVERY_CODE_SECRET } from "@appflare/schema";
import { getCfClient } from "../cloudflare/client.server";
import { settingsPlace } from "../components/settings-links";
import { createDb } from "../db/client";
import { deleteSettings, readSettings, SETTING, writeSettings } from "../db/settings";
import { activeVersionId } from "../jobs/update/plan";
import { AUTH_EMAIL_BINDING, type OutgoingEmail, resetEmail } from "./password-email";

/**
 * Password reset emails on the manager itself, and removing a used recovery
 * code secret.
 *
 * Reset emails are on when the running Worker has its `AUTH_EMAIL`
 * `send_email` binding and a sender address is saved. The owner turns them on
 * in Settings > Users: the manager makes a new version of itself from the one
 * that serves, with only that binding added (a JSON merge patch of the latest
 * version, as connecting sandbox builds does), and deploys it. The binding
 * may send only from the saved address. Appflare's self-updates copy the
 * binding to each new version, so it stays until turned off.
 */

/** A refused change; its message is shown as is. */
export class PasswordEmailError extends Error {
  override name = "PasswordEmailError";
}

export const PASSWORD_EMAIL_MESSAGES = {
  gradual:
    "No single version serves all of Appflare's traffic (a gradual deployment is in progress). Finish or undo it in the Cloudflare dashboard first.",
  unreleased: (latest: string, serving: string) =>
    `The newest uploaded version of Appflare's Worker (${latest}) is not the one serving (${serving}), and changing reset emails would deploy it too. Deploy the version you want from the Worker's Deployments page in the Cloudflare dashboard, or update Appflare in ${settingsPlace("updates", "appflare", "the Updates settings")}, then try again.`,
  noWorkerName: `Appflare does not know its own Worker name yet. Save the Cloudflare token in ${settingsPlace("account", "connection", "the Cloudflare connection settings")} first.`,
} as const;

/** The message of every version turning reset emails on; never change it. */
export const EMAIL_ON_MESSAGE = "Appflare: turn on password reset emails";
/** The message of every version turning reset emails off; never change it. */
export const EMAIL_OFF_MESSAGE = "Appflare: turn off password reset emails";

export interface PasswordEmailStatus {
  /** The running Worker has the `AUTH_EMAIL` binding. */
  bound: boolean;
  /** The saved sender address, or null. */
  sender: string | null;
  /** Reset emails are sent: bound and a sender saved. */
  enabled: boolean;
}

export async function readPasswordEmailSender(d1: D1Database): Promise<string | null> {
  const row = await readSettings(createDb(d1), [SETTING.passwordResetSender]);
  return row.password_reset_sender ?? null;
}

export async function passwordEmailStatus(
  d1: D1Database,
  binding: SendEmail | undefined,
): Promise<PasswordEmailStatus> {
  const sender = await readPasswordEmailSender(d1);
  const bound = binding !== undefined;
  return { bound, sender, enabled: bound && sender !== null };
}

/**
 * Sends a reset link from the saved address. Runs after the response, so a
 * failure is logged (its error code only, never the address) and not shown.
 */
export async function sendResetEmailFromSettings(
  d1: D1Database,
  binding: SendEmail,
  args: { to: string; url: string },
): Promise<void> {
  const sender = await readPasswordEmailSender(d1);
  if (sender === null) return;
  try {
    await sendEmail(binding, resetEmail({ from: sender, ...args }));
  } catch (error) {
    console.error("password reset email not sent", { code: errorCode(error) });
  }
}

export async function sendEmail(binding: SendEmail, email: OutgoingEmail): Promise<void> {
  await binding.send({
    from: { email: email.from, name: "Appflare" },
    to: email.to,
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "unknown";
}

/**
 * Whether `version` is an earlier attempt of this action made from the
 * version that serves (its message and tag), which never served. Cloudflare
 * cannot delete versions, so without this a failed deploy would block every
 * retry.
 */
function isEarlierAttempt(
  version: { annotations?: Record<string, string> },
  serving: string,
): boolean {
  const message = version.annotations?.["workers/message"];
  return (
    (message === EMAIL_ON_MESSAGE || message === EMAIL_OFF_MESSAGE) &&
    version.annotations?.["workers/tag"] === serving
  );
}

/**
 * Adds the `AUTH_EMAIL` binding (sending only from `sender`), or removes it
 * with `sender: null`, in a new version made from the serving one, and
 * deploys it. Returns the new version's id.
 */
export async function changeAuthEmailBinding(
  deps: { api: Pick<CloudflareClient, "versions">; workerName: string },
  sender: string | null,
): Promise<string> {
  const { api, workerName } = deps;
  const serving = activeVersionId(await api.versions.listDeployments(workerName));
  if (serving === null) throw new PasswordEmailError(PASSWORD_EMAIL_MESSAGES.gradual);
  const versions = await api.versions.listVersions(workerName);
  const latest = [...versions].sort((a, b) => (b.number ?? 0) - (a.number ?? 0))[0];
  if (latest === undefined || (latest.id !== serving && !isEarlierAttempt(latest, serving))) {
    throw new PasswordEmailError(
      PASSWORD_EMAIL_MESSAGES.unreleased(latest?.id ?? "unknown", serving),
    );
  }
  const message = sender === null ? EMAIL_OFF_MESSAGE : EMAIL_ON_MESSAGE;
  const created = await api.versions.patchLatestVersion(workerName, {
    env: {
      [AUTH_EMAIL_BINDING]:
        sender === null ? null : { type: "send_email", allowed_sender_addresses: [sender] },
    },
    annotations: { "workers/message": message, "workers/tag": serving },
  });
  await api.versions.createDeployment(workerName, {
    versions: [{ version_id: created.id, percentage: 100 }],
    annotations: { "workers/message": message },
  });
  return created.id;
}

export interface SetPasswordEmailDeps {
  d1: D1Database;
  api: Pick<CloudflareClient, "versions">;
  now: Date;
}

/**
 * Turns reset emails on with `sender` (saving it and giving the Worker a
 * binding that may send only from it), or off with `null` (removing both).
 */
export async function setPasswordEmailSender(
  deps: SetPasswordEmailDeps,
  sender: string | null,
): Promise<{ versionId: string }> {
  const orm = createDb(deps.d1);
  const { worker_name: workerName } = await readSettings(orm, [SETTING.workerName]);
  if (!workerName) throw new PasswordEmailError(PASSWORD_EMAIL_MESSAGES.noWorkerName);
  const versionId = await changeAuthEmailBinding({ api: deps.api, workerName }, sender);
  if (sender === null) await deleteSettings(orm, [SETTING.passwordResetSender]);
  else await writeSettings(orm, { [SETTING.passwordResetSender]: sender }, deps.now);
  return { versionId };
}

/**
 * Deletes `RECOVERY_CODE_HASH` from the manager's Worker once its code was
 * used (the used code is also recorded, so this is tidying up, and a failure
 * is only logged). Deleting a secret deploys a new version of the same code.
 */
export async function deleteRecoverySecret(env: {
  DB: D1Database;
  CF_API_TOKEN?: string;
  CF_GRANT_KEY?: string;
  CF_API_BASE_URL?: string;
}): Promise<void> {
  try {
    const { worker_name: workerName } = await readSettings(createDb(env.DB), [SETTING.workerName]);
    if (!workerName) return;
    const api = await getCfClient(env);
    await api.workers.deleteSecret(workerName, RECOVERY_CODE_SECRET);
  } catch (error) {
    console.error("could not delete the used recovery code secret", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
