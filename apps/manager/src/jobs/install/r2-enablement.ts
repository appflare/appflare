import { CloudflareApiError, type CloudflareError } from "@appflare/cf-api";
import { JobError } from "../steps";

/**
 * Recognising Cloudflare's refusal of R2 calls on an account where R2 was
 * never enabled. R2 is an account add-on: until someone adds it in the
 * dashboard, which asks for a payment method even for the free tier, every R2
 * API call (listing buckets included) fails with HTTP 403 and error code 10042,
 * "Please enable R2 through the Cloudflare Dashboard." The code is matched
 * first; the message is a fallback in case the code changes.
 */

export const R2_NOT_ENABLED_CODE = 10042;

const NOT_ENABLED_MESSAGE = /enable R2/i;

function matches(errors: CloudflareError[]): boolean {
  return errors.some(
    (e) =>
      e.code === R2_NOT_ENABLED_CODE ||
      NOT_ENABLED_MESSAGE.test(e.message) ||
      (e.error_chain !== undefined && matches(e.error_chain)),
  );
}

/** Whether a Cloudflare call failed because R2 is not enabled on the account. */
export function isR2NotEnabled(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status < 500 && matches(error.errors);
}

/** What the install reports instead of the raw API error. */
export function r2NotEnabledMessage(bucket: string): string {
  return (
    `R2 is not enabled on this Cloudflare account, so the R2 bucket ${bucket} cannot be created. ` +
    "Enable R2 in the Cloudflare dashboard under R2 Object Storage. Cloudflare asks for a payment " +
    "method on file before enabling R2, even though its free tier costs nothing. " +
    "Then try again."
  );
}

/**
 * Runs an R2 call for `bucket`, turning Cloudflare's "R2 is not enabled"
 * refusal into a {@link JobError} that says what to do. Other errors pass
 * through unchanged, so retries and their classification stay as they were.
 */
export async function explainR2Refusal<T>(bucket: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isR2NotEnabled(error)) throw new JobError(r2NotEnabledMessage(bucket));
    throw error;
  }
}
