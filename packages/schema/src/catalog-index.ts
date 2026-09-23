import { z } from "zod";
import { sha256Schema } from "./artifact";
import {
  expectedBuildMinutesSchema,
  gitShaSchema,
  installTierSchema,
  planSchema,
  requirementSchema,
  sandboxInstanceTypeSchema,
} from "./catalog";

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

/**
 * How a `sandbox` tier entry is built in the user's account: catalog CI does
 * not publish a prebuilt artifact for it, so the manager asks its sandbox
 * Worker to build the pinned commit. The entry's catalog manifest is
 * published next to the index, addressed by its sha256, because the build
 * request carries it verbatim and the install form is generated from it.
 */
export const indexBuildSchema = z.object({
  /** The exact commit the build checks out; equals the catalog manifest's `source.sha`. */
  pin: gitShaSchema,
  /** URL of the entry's catalog manifest as JSON. */
  manifest: z.url(),
  /** sha256 of the exact bytes at `manifest`. */
  manifestDigest: sha256Schema,
  /** The entry's `install.buildCommand`, repeated for display. */
  buildCommand: z.string().min(1).optional(),
  /** Wall-clock minutes a build usually takes, for the cost estimate. */
  expectedMinutes: expectedBuildMinutesSchema.optional(),
  /** Container size the build needs; `standard-1` when omitted. */
  instanceType: sandboxInstanceTypeSchema.optional(),
});
export type IndexBuild = z.infer<typeof indexBuildSchema>;

/**
 * One app entry in the published catalog index. `artifact` tier entries
 * carry the release URLs and the manifest digest; `sandbox` tier entries
 * carry `build` instead and may omit both.
 */
export const indexAppSchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().min(1),
    summary: z.string().min(1),
    version: z.string().min(1),
    artifacts: indexArtifactsSchema.optional(),
    digest: sha256Schema.optional(),
    tier: installTierSchema,
    plan: planSchema,
    requires: z.array(requirementSchema),
    lastVerified: z.iso.datetime().nullable(),
    maintainers: z.array(z.string().min(1)),
    build: indexBuildSchema.optional(),
  })
  .superRefine((app, ctx) => {
    if ((app.artifacts === undefined) !== (app.digest === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [app.artifacts === undefined ? "artifacts" : "digest"],
        message: "artifacts and digest come together",
      });
    }
    if (app.tier === "artifact" && app.artifacts === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "an artifact tier entry needs its release artifacts",
      });
    }
    if (app.tier === "sandbox" && app.build === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["build"],
        message: "a sandbox tier entry needs a build block",
      });
    }
  });
export type IndexApp = z.infer<typeof indexAppSchema>;

/** The prebuilt artifact of an entry, or null when it has none (a sandbox tier entry). */
export function indexAppArtifact(
  app: Pick<IndexApp, "artifacts" | "digest">,
): { artifacts: IndexArtifacts; digest: string } | null {
  return app.artifacts === undefined || app.digest === undefined
    ? null
    : { artifacts: app.artifacts, digest: app.digest };
}

/** The published catalog index, `index.json`. */
export const indexJsonSchema = z.object({
  generatedAt: z.iso.datetime(),
  apps: z.array(indexAppSchema),
});
export type IndexJson = z.infer<typeof indexJsonSchema>;
