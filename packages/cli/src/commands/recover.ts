import {
  generateRecoveryCode,
  normalizeRecoveryEmail,
  RECOVERY_CODE_SECRET,
  RECOVERY_CODE_TTL_MS,
  recoveryCodeSecretValue,
} from "@appflare/schema";
import { z } from "zod";
import { ensureAccount } from "../account.ts";
import { type CommandContext, wranglerFor } from "../context.ts";
import { DEFAULT_WORKER_NAME, validateWorkerName } from "../names.ts";
import { checkNodeVersion } from "../node-version.ts";
import { withWorkdir } from "../workdir.ts";
import {
  isWorkerNotFound,
  parseJsonOutput,
  type Wrangler,
  WranglerError,
  wranglerArgs,
} from "../wrangler.ts";

/** Options of `create-appflare recover`. */
export interface RecoverOptions {
  /** The manager's Worker name; `appflare` by default. */
  name?: string;
  /** Never prompt. */
  yes: boolean;
  /** Make the code work only with this admin's email. */
  email?: string;
  /** The time the code starts to count down from; now by default (tests). */
  now?: () => number;
}

/** The secret every set-up manager has; a Worker without it is not one. */
const MANAGER_SECRET = "BETTER_AUTH_SECRET";

const secretListSchema = z.array(z.looseObject({ name: z.string() }));

/** Names of the Worker's secrets; null when there is no Worker of that name. */
async function secretNames(wrangler: Wrangler, worker: string): Promise<string[] | null> {
  const result = await wrangler.run(wranglerArgs.secretList(worker));
  if (result.code !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (isWorkerNotFound(result) || /Worker "[^"]*" not found/.test(output)) return null;
    throw new WranglerError("secret list", result);
  }
  return secretListSchema
    .parse(parseJsonOutput("secret list", result.stdout))
    .map((secret) => secret.name);
}

/** What `recover` prints on stdout: the code and how to use it. */
export function recoveryInstructions(code: string, minutes: number, email?: string): string {
  const who =
    email === undefined
      ? "Enter the email of any admin (the owner included), this code, and a new password."
      : `Enter ${email} (the code works with no other email), this code, and a new password.`;
  return [
    "",
    `Your recovery code (it works once, for ${minutes} minutes):`,
    "",
    `    ${code}`,
    "",
    'On your Appflare sign-in page, choose "Forgot your password?", then "I have a',
    'recovery code".',
    who,
    "Appflare restarts to pick the code up, so wait about 10 seconds first.",
  ].join("\n");
}

/** A plausible email address, lower-cased; throws otherwise. */
export function recoveryEmail(value: string): string {
  const email = normalizeRecoveryEmail(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error(`--email: "${value}" is not an email address`);
  }
  return email;
}

/**
 * `create-appflare recover`: for when the owner or an admin forgot their
 * password. Whoever can change the manager's Worker in the Cloudflare account
 * proves it by writing a secret on it: a new random recovery code's hash and
 * expiry go into `RECOVERY_CODE_HASH`, and the code itself is printed once
 * and never stored. Writing the secret deploys a new version of the manager
 * with the same code. The manager deletes the secret once the code is used.
 * With `--email`, the email is hashed with the code, so it works only for
 * that admin.
 * Sends no usage data.
 */
export async function recover(options: RecoverOptions, ctx: CommandContext): Promise<void> {
  const { ui, env } = ctx;
  checkNodeVersion(ctx.nodeVersion);
  const name = validateWorkerName(options.name ?? DEFAULT_WORKER_NAME);
  const email = options.email === undefined ? undefined : recoveryEmail(options.email);

  await withWorkdir(async ({ dir, neutralConfig }) => {
    const wrangler = wranglerFor(ctx, dir, neutralConfig);
    await ensureAccount(wrangler, ui, { env, yes: options.yes });

    ui.step(`Checking that "${name}" is your Appflare`);
    const secrets = await secretNames(wrangler, name);
    if (secrets === null) {
      throw new Error(
        `There is no Worker named "${name}" in this account. If you installed Appflare under ` +
          "another name, run `npx create-appflare recover --name <name>`.",
      );
    }
    if (!secrets.includes(MANAGER_SECRET)) {
      throw new Error(
        `The Worker "${name}" is not a set-up Appflare (it has no ${MANAGER_SECRET}). ` +
          "Check the name, or finish setup by opening Appflare first.",
      );
    }

    ui.step("Saving a one-time recovery code on Appflare");
    const code = generateRecoveryCode();
    const expiresAt = (options.now ?? Date.now)() + RECOVERY_CODE_TTL_MS;
    const result = await wrangler.run(wranglerArgs.secretPut(name, RECOVERY_CODE_SECRET), {
      stdin: { kind: "text", text: await recoveryCodeSecretValue(code, expiresAt, email) },
    });
    if (result.code !== 0) {
      throw new WranglerError(`secret put ${RECOVERY_CODE_SECRET}`, result);
    }
    ui.info("Saved. Appflare keeps only a fingerprint of the code, never the code itself.");
    ui.result(recoveryInstructions(code, RECOVERY_CODE_TTL_MS / 60_000, email));
  }, ctx.tmpRoot);
}
