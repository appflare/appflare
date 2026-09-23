import { z } from "zod";

/**
 * Client-safe install input rules shared by the `/catalog/$slug` form and the
 * `startInstall` server function (which re-validates against the catalog entry).
 */

/** Worker names Appflare accepts at install (editable, default from the catalog). */
/** A DNS label (it becomes `<name>.<subdomain>.workers.dev`): no leading or trailing dash. */
export const WORKER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,52}[a-z0-9])?$/;

export const WORKER_NAME_HINT =
  "1 to 54 lowercase letters, digits, or dashes, not starting or ending with a dash.";

export const workerNameSchema = z
  .string()
  .regex(WORKER_NAME_PATTERN, `The Worker name must be ${WORKER_NAME_HINT}`);

/** Values are bounded so a pasted blob cannot bloat the Workflow payload. */
const MAX_VALUE_LENGTH = 4096;

export const startInstallInput = z.object({
  slug: z.string().min(1).max(100),
  workerName: workerNameSchema,
  /** Secret values by name. Never logged, never stored outside the Workflow payload. */
  secrets: z.record(z.string().max(200), z.string().max(MAX_VALUE_LENGTH)),
  vars: z.record(z.string().max(200), z.string().max(MAX_VALUE_LENGTH)),
  paidConfirmed: z.boolean(),
});
export type StartInstallInput = z.infer<typeof startInstallInput>;

/** Length of a value generated for a `generate: true` secret. */
export const GENERATED_SECRET_LENGTH = 32;
