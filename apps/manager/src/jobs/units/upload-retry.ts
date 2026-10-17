import { CloudflareApiError, type ScriptMetadata } from "@appflare/cf-api";
import { errorMessage, JobError } from "../errors";
import type { StepLog } from "../step-log";

/**
 * Two refusals of a Worker upload that sending it again can fix, handled
 * inside the `uploadWorker` unit:
 *
 * - The assets completion token was taken already (400, code 100312,
 *   "Completion token has already been consumed"): Cloudflare takes one
 *   once, so a step retried after an upload that went through but whose
 *   answer was lost sends a spent token. A new upload session for the same
 *   files gives a new one; the files are stored already, so it asks for
 *   none of them.
 * - The Worker's startup went over Cloudflare's CPU time limit (400, code
 *   10021, "Script startup exceeded CPU time limit"). How long a startup
 *   takes varies from one upload to the next (one install of an app hit it
 *   where 22 others did not), so the upload is sent once more after a short
 *   pause; a second refusal ends the step with a sentence that says so.
 */

/** Cloudflare's code for an assets completion token it already took. */
export const CONSUMED_ASSETS_TOKEN_CODE = 100312;

/** Cloudflare's code for a refused upload; with the startup message, the startup CPU limit. */
export const STARTUP_CPU_CODE = 10021;

/** How long the unit waits before it sends an upload whose startup went over the limit again. */
export const STARTUP_RETRY_PAUSE_MS = 3_000;

function hasError(error: unknown, code: number, message: RegExp): boolean {
  return (
    error instanceof CloudflareApiError &&
    error.errors.some((e) => e.code === code || message.test(e.message))
  );
}

/** Whether Cloudflare refused an upload because its assets completion token was spent. */
export function isConsumedAssetsToken(error: unknown): boolean {
  return hasError(error, CONSUMED_ASSETS_TOKEN_CODE, /completion token has already been consumed/i);
}

/** Whether Cloudflare refused an upload because the Worker's startup went over its CPU time limit. */
export function isStartupCpuLimit(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    error.errors.some(
      (e) => e.code === STARTUP_CPU_CODE && /startup exceeded CPU time limit/i.test(e.message),
    )
  );
}

/**
 * Sends an upload (`call`, given the metadata to send) and handles the two
 * refusals above: the startup refusal once, a spent token once before it
 * and once after it. `renewAssets` opens the new upload
 * session and returns its token, or null when it cannot (the caller sent no
 * asset files), which leaves Cloudflare's refusal as it is.
 */
export async function uploadRetried<T>(
  call: (metadata: ScriptMetadata) => Promise<T>,
  metadata: ScriptMetadata,
  opts: {
    renewAssets: () => Promise<string | null>;
    pause: (ms: number) => Promise<void>;
    log: StepLog;
  },
): Promise<T> {
  let sent = metadata;
  let renewed = false;
  let startupRetried = false;
  for (;;) {
    try {
      return await call(sent);
    } catch (error) {
      if (!renewed && sent.assets?.jwt !== undefined && isConsumedAssetsToken(error)) {
        renewed = true;
        const jwt = await opts.renewAssets();
        if (jwt === null) throw error;
        sent = { ...sent, assets: { ...sent.assets, jwt } };
        continue;
      }
      if (isStartupCpuLimit(error)) {
        if (!startupRetried) {
          startupRetried = true;
          // The upload sent again may meet a token Cloudflare took with the
          // refused one: one more new token is allowed.
          renewed = false;
          opts.log.warn(
            "Cloudflare refused the upload: the app's startup used more CPU time than Cloudflare allows. Startup time varies, so the upload is sent once more.",
          );
          await opts.pause(STARTUP_RETRY_PAUSE_MS);
          continue;
        }
        throw new JobError(
          `the app's startup took too long for Cloudflare: it refused the upload twice because the Worker's startup used more CPU time than it allows (${errorMessage(error)}). How long a startup takes varies from one try to the next, so trying again often works`,
        );
      }
      throw error;
    }
  }
}

/**
 * The `assetFiles` of an upload whose metadata carries `jwt`, the completion
 * token of an upload session for `files`; none without a token.
 */
export function assetFilesOf(
  files: ReadonlyArray<{ route: string; hash: string; size: number }>,
  jwt: string | null,
): { assetFiles?: Array<{ route: string; hash: string; size: number }> } {
  if (jwt === null || files.length === 0) return {};
  return { assetFiles: files.map(({ route, hash, size }) => ({ route, hash, size })) };
}
