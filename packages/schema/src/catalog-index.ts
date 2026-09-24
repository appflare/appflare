import { z } from "zod";
import { sha256Schema } from "./artifact";
import {
  catalogAuthorSchema,
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
 * How a `sandbox` or `self-deploying` tier entry runs in the user's account:
 * catalog CI does not publish a prebuilt artifact for either, so the manager
 * asks its sandbox Worker to build the pinned commit (`sandbox`) or to run the
 * app's own installer there (`self-deploying`). The entry's catalog manifest
 * is published next to the index, addressed by its sha256, because the
 * request carries it verbatim and the install form is generated from it.
 * `expectedMinutes` and `instanceType` are the entry's `install.sandbox`,
 * copied for the cost estimate the manager shows before each run.
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
  /** Wall-clock minutes a run (build or installer) usually takes, for the cost estimate. */
  expectedMinutes: expectedBuildMinutesSchema.optional(),
  /** Container size the run needs; `standard-1` when omitted. */
  instanceType: sandboxInstanceTypeSchema.optional(),
});
export type IndexBuild = z.infer<typeof indexBuildSchema>;

/**
 * One app entry in the published catalog index. `artifact` tier entries
 * carry the release URLs and the manifest digest; `sandbox` and
 * `self-deploying` tier entries carry `build` instead and may omit both (a
 * self-deploying entry's `build` points at the catalog manifest that holds
 * its installer's commands; `expectedMinutes` and `instanceType` size the
 * container the installer runs in).
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
    /**
     * Who wrote the app: the catalog manifest's `authors`, or the owner of its
     * `repo` when it lists none. Catalog CI always writes it; optional so an
     * index published before the field existed still parses.
     */
    authors: z.array(catalogAuthorSchema).min(1).optional(),
    /** Who packages the app for the catalog. */
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
    // A self-deploying entry has no artifact either: the manager reads its
    // catalog manifest (the installer's commands) from the same block.
    if (app.tier === "self-deploying" && app.build === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["build"],
        message: "a self-deploying tier entry needs a build block",
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
