import { buildCommandChoiceSchema } from "@appflare/schema";
import { z } from "zod";
import { startInstallInput } from "./install-input";

/**
 * Client-safe inputs of builds from a repository and from source, shared by
 * the forms and the server functions (which check everything again).
 */

const refInput = z.string().trim().max(200).optional();

export const startSourceBuildInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("repository"),
    /** A GitHub URL or `owner/repo`, as typed. */
    repository: z.string().trim().min(1, "Enter a repository.").max(400),
    ref: refInput,
    buildCommand: buildCommandChoiceSchema.optional(),
    costConfirmed: z.boolean(),
  }),
  z.object({
    kind: z.literal("source"),
    slug: z.string().min(1).max(100),
    ref: refInput,
    buildCommand: buildCommandChoiceSchema.optional(),
    costConfirmed: z.boolean(),
  }),
  z.object({
    kind: z.literal("rebuild"),
    installId: z.string().min(1).max(64),
    costConfirmed: z.boolean(),
  }),
]);
export type StartSourceBuildInput = z.infer<typeof startSourceBuildInput>;

export const sourceBuildIdInput = z.object({ buildId: z.string().min(1).max(64) });

/** The install form of a reviewed build: the catalog form's fields, minus what the build decides. */
export const installSourceBuildInput = startInstallInput
  .omit({ slug: true, buildConfirmed: true, appToken: true, replaces: true })
  .extend({ buildId: z.string().min(1).max(64) });
export type InstallSourceBuildInput = z.infer<typeof installSourceBuildInput>;

export const updateFromSourceBuildInput = z.object({
  buildId: z.string().min(1).max(64),
  /** Values of the secrets the rebuild introduces. */
  secrets: z.record(z.string().max(200), z.string().max(4096)).optional(),
  confirmNoPreview: z.boolean().optional(),
  /** The admin saw how the rebuild changes the app's Email Routing. */
  confirmEmailRouting: z.boolean().optional(),
});
export type UpdateFromSourceBuildInput = z.infer<typeof updateFromSourceBuildInput>;

/** How the review and the app page call where an install's code comes from. Client-safe. */
export const NOT_FROM_CATALOG = "Not from the catalog, not checked";

/** The same for a catalog app built from source at another commit. */
export const BUILT_FROM_SOURCE = "Built from source, not checked";
