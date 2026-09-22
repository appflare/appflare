import { z } from "zod";
import { sha256Schema } from "./artifact";
import { installTierSchema, planSchema, requirementSchema } from "./catalog";

/**
 * Schema for the generated `index.json` published to GitHub Pages.
 * One row per app plus a top-level `generatedAt`.
 */

/** Release-asset URLs for one app version. */
export const indexArtifactsSchema = z.object({
  zip: z.url(),
  manifest: z.url(),
  sig: z.url(),
});
export type IndexArtifacts = z.infer<typeof indexArtifactsSchema>;

/** One app entry in the published catalog index. */
export const indexAppSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().min(1),
  version: z.string().min(1),
  artifacts: indexArtifactsSchema,
  digest: sha256Schema,
  tier: installTierSchema,
  plan: planSchema,
  requires: z.array(requirementSchema),
  lastVerified: z.iso.datetime().nullable(),
  maintainers: z.array(z.string().min(1)),
});
export type IndexApp = z.infer<typeof indexAppSchema>;

/** The published catalog index, `index.json`. */
export const indexJsonSchema = z.object({
  generatedAt: z.iso.datetime(),
  apps: z.array(indexAppSchema),
});
export type IndexJson = z.infer<typeof indexJsonSchema>;
