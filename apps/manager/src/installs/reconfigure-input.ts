import { z } from "zod";
import { MAX_NAME_LENGTH, MAX_VALUE_LENGTH, secretChangesSchema } from "../jobs/reconfigure/plan";

/** Client-safe input of the server function that saves an install's settings and redeploys it. */

export const startReconfigureInput = z.object({
  installId: z.string().min(1).max(64),
  /**
   * The app's settings that differ from their default, as the install form
   * sends them; a setting left out (or empty) follows its default.
   */
  vars: z.record(z.string().max(MAX_NAME_LENGTH), z.string().max(MAX_VALUE_LENGTH)).default({}),
  /** New secret values (never logged; names only in the job record) and names to remove. */
  secrets: secretChangesSchema.default({ set: {}, unset: [] }),
  /** For an app that receives email: the zone to receive it for instead of the current one. */
  emailRouting: z
    .object({ zoneId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Choose a zone.") })
    .optional(),
  /** The admin accepted that the new settings cannot be checked on a preview first. */
  confirmNoPreview: z.boolean().optional(),
  /** For a self-deploying app: the admin confirmed the cost of running its installer. */
  buildConfirmed: z.boolean().optional(),
});
export type StartReconfigureInput = z.input<typeof startReconfigureInput>;
