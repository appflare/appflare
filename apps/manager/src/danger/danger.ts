/** The danger-zone endpoints and the phrase typed to rotate. Client-safe. */

export const ROTATE_PATH = "/api/danger/rotate-auth-secret";
export const REMOVE_PATH = "/api/danger/remove-appflare";

/** The phrase typed to confirm a rotation. */
export const ROTATE_CONFIRMATION = "rotate";

/**
 * Whether removing Appflare deletes the `appflare-builds` bucket: only when
 * it exists and the sandbox Worker that uses it is Appflare's. A bucket of
 * that name next to another Worker, or kept on purpose after the sandbox
 * Worker was removed on its own, is left alone.
 */
export function deletesBuildBucket(sandbox: { worker: string; bucket: boolean }): boolean {
  return sandbox.bucket && sandbox.worker === "sandbox";
}
