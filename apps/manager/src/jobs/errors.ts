import { NonRetryableError } from "cloudflare:workflows";
import { CloudflareApiError } from "@appflare/cf-api";
import { ArtifactError, ArtifactFetchError } from "./install/artifact";
import { isSubrequestLimitError, subrequestLimitMessage } from "./install/budget";

/**
 * How job failures are classified: 429/5xx and network errors are retried by
 * the Workflow engine; 4xx, integrity failures, and the subrequest limit end
 * the job at once (`NonRetryableError`).
 */

/** A failure the job reports as is; never retried. */
export class JobError extends Error {
  override name = "JobError";
}

/** Maps any error thrown inside a step to what the Workflow engine should do with it. */
export function toStepError(error: unknown): Error {
  if (error instanceof NonRetryableError) return error;
  const message = error instanceof Error ? error.message : String(error);
  // The same work would hit the same limit again, so a retry cannot help.
  if (isSubrequestLimitError(error)) return new NonRetryableError(subrequestLimitMessage(message));
  if (error instanceof CloudflareApiError) {
    return error.status === 429 || error.status >= 500
      ? new Error(message)
      : new NonRetryableError(message);
  }
  if (error instanceof ArtifactFetchError) {
    return error.retryable ? new Error(message) : new NonRetryableError(message);
  }
  if (error instanceof JobError || error instanceof ArtifactError) {
    return new NonRetryableError(message);
  }
  return error instanceof Error ? error : new Error(message);
}

/** The message without the engine's `Error:` prefixes. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^(NonRetryableError|Error):\s*/, "");
}

/** Whether a Cloudflare call failed because the object does not exist (anymore). */
export function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}
