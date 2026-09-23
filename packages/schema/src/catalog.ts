import { z } from "zod";

/**
 * Schemas for the human-authored catalog manifest `appflare.jsonc`.
 * Everything derivable from the wrangler config
 * (bindings, DO migrations, compat, assets, crons) is NOT repeated here; the
 * packer reads it from the pinned checkout.
 */

/** 40-character lowercase hex git commit SHA. */
export const gitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a 40-character lowercase hex git SHA");

/** `owner/repo` GitHub slug. */
export const ownerRepoSchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be "owner/repo"');

/**
 * A semver version without a leading `v` (`1.2.3`, `2.0.0-rc.1`), as artifact
 * versions and release tags `<slug>@<version>` carry it.
 */
export const semverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "must be a semver version such as 1.2.3, without a leading v",
  );

/** How an app is built. v1 ships `artifact` only. */
export const installTierSchema = z.enum(["artifact", "sandbox", "self-deploying"]);
export type InstallTier = z.infer<typeof installTierSchema>;

/** Package manager the packer uses to build the app from its checkout. */
export const packageManagerSchema = z.enum(["pnpm", "npm", "yarn", "bun"]);
export type PackageManager = z.infer<typeof packageManagerSchema>;

/** Free vs paid plan requirement. */
export const planSchema = z.enum(["free", "paid"]);
export type Plan = z.infer<typeof planSchema>;

/** Account capability an app needs beyond the free Workers baseline. */
export const requirementSchema = z.enum([
  "r2",
  "zone",
  "email-routing",
  "workers-ai",
  "browser-rendering",
  "containers",
]);
export type Requirement = z.infer<typeof requirementSchema>;

/**
 * A secret the installer prompts for. `generate: true` means the manager mints a
 * random value instead of asking the user. Defaults are seeded by catalog CI from
 * `.dev.vars.example` when the manifest omits them.
 */
export const catalogSecretSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  help: z.string().optional(),
  generate: z.boolean().default(false),
});
export type CatalogSecret = z.infer<typeof catalogSecretSchema>;

/** A plain (non-secret) var the installer prompts for; becomes a `plain_text` binding. */
export const catalogVarSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  help: z.string().optional(),
  default: z.string().optional(),
  required: z.boolean().default(false),
});
export type CatalogVar = z.infer<typeof catalogVarSchema>;

/** A post-install instruction rendered after a successful install (e.g. `{{workerUrl}}`). */
export const postInstallStepSchema = z.object({
  type: z.enum(["markdown"]),
  content: z.string().min(1),
});
export type PostInstallStep = z.infer<typeof postInstallStepSchema>;

/**
 * A Cloudflare API-token permission an app needs for ITS OWN token (never the
 * manager's). Shown to the user so they can mint a scoped token at
 * install time. Kept descriptive rather than tied to Cloudflare's internal
 * permission-group ids, which can be added later if the UI needs them.
 */
export const tokenPermissionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  scope: z.enum(["account", "zone", "user"]).optional(),
});
export type TokenPermission = z.infer<typeof tokenPermissionSchema>;

/** How a Vectorize index measures the distance between two vectors. */
export const vectorizeMetricSchema = z.enum(["cosine", "euclidean", "dot-product"]);
export type VectorizeMetric = z.infer<typeof vectorizeMetricSchema>;

/**
 * The fixed shape of a Vectorize index. Cloudflare needs both to create the
 * index and neither can change afterwards; wrangler's config does not carry
 * them (`wrangler vectorize create` takes them as flags), so the catalog
 * manifest states them. Vectorize allows at most 1536 dimensions.
 */
export const vectorizeIndexConfigSchema = z.object({
  dimensions: z.int().min(1).max(1536),
  metric: vectorizeMetricSchema,
});
export type VectorizeIndexConfig = z.infer<typeof vectorizeIndexConfigSchema>;

/**
 * Settings for resources the app's wrangler config binds but cannot fully
 * describe. `vectorize` is keyed by binding name and must cover every
 * Vectorize binding in the wrangler config; the packer refuses one without it.
 */
export const catalogResourcesSchema = z.object({
  vectorize: z.record(z.string().min(1), vectorizeIndexConfigSchema).optional(),
});
export type CatalogResources = z.infer<typeof catalogResourcesSchema>;

/** The pinned upstream source a version is built from; the bump bot edits it. */
export const catalogSourceSchema = z.object({
  ref: z.string().min(1),
  sha: gitShaSchema,
});
export type CatalogSource = z.infer<typeof catalogSourceSchema>;

/** How the packer builds and names the app. */
export const catalogInstallSchema = z.object({
  tier: installTierSchema,
  packageManager: packageManagerSchema,
  wranglerConfig: z.string().min(1),
  /** The default Worker name; the installer may change it unless `fixedWorkerName` is set. */
  workerName: z.string().min(1),
  /**
   * The app only works under `workerName` (for example, it hard-codes its own
   * hostname), so it installs at most once per account. Omitted means false.
   * Optional rather than defaulted so manifests and artifacts written before the
   * field existed keep the same parsed shape.
   */
  fixedWorkerName: z.boolean().optional(),
  /**
   * The path the manager probes to tell whether the app serves, for example
   * `/api/health`. When it answers JSON with a string `version`, an update's
   * check of the new version requires that version. Omitted means `/`;
   * optional for the same reason as `fixedWorkerName`.
   */
  healthPath: z
    .string()
    .regex(/^\/[^\s?#]*$/, "healthPath is a URL path starting with /, without query or fragment")
    .optional(),
  /**
   * The version shown for this entry when the repository's tag does not
   * describe this app (monorepos); it must change whenever `source` moves.
   * Omitted means the version comes from `source.ref` when it is a semver tag,
   * else from the pinned commit's date and SHA.
   */
  version: semverSchema
    .describe(
      "The version shown for this entry when the repository's tag does not describe this app " +
        "(monorepos); it must change whenever `source` moves.",
    )
    .optional(),
});
export type CatalogInstall = z.infer<typeof catalogInstallSchema>;

/** Whether the app must run under its catalog `workerName` (and so installs once). */
export function hasFixedWorkerName(install: Pick<CatalogInstall, "fixedWorkerName">): boolean {
  return install.fixedWorkerName === true;
}

/** The path health checks probe: `install.healthPath`, else `/`. */
export function appHealthPath(install: Pick<CatalogInstall, "healthPath">): string {
  return install.healthPath ?? "/";
}

/**
 * How the catalog's bump bot treats an entry when its upstream moves.
 *
 * `autoMerge: true` makes the bot's pull request merge itself (squash) once the
 * required checks, the full install check included, pass. Without it, or with
 * `false`, a maintainer reviews and merges each bump. Set it for entries whose
 * maintainers trust upstream's tags to be releasable as they are. The bot does
 * not auto-merge an entry that sets `install.version`, because a person has to
 * update that version with each bump.
 */
export const catalogBumpSchema = z
  .object({
    autoMerge: z
      .boolean()
      .describe(
        "Let the bump bot's pull request merge itself once the required checks, including " +
          "the install check, pass. For entries whose maintainers trust upstream's tags to be " +
          "releasable as they are.",
      ),
  })
  .describe("How the catalog's bump bot treats this entry when its upstream moves.");
export type CatalogBump = z.infer<typeof catalogBumpSchema>;

/** The full catalog manifest, `appflare.jsonc`. */
export const catalogManifestSchema = z.object({
  $schema: z.url().optional(),
  slug: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().min(1),
  /** Shown as a link in the manager; https only (the regex also lands in the JSON Schema). */
  homepage: z
    .url({ protocol: /^https$/, error: "must be an https:// URL" })
    .regex(/^https:\/\//, "must be an https:// URL"),
  repo: ownerRepoSchema,
  license: z.string().min(1),
  categories: z.array(z.string().min(1)),
  maintainers: z.array(z.string().min(1)),
  source: catalogSourceSchema,
  install: catalogInstallSchema,
  plan: planSchema,
  requires: z.array(requirementSchema),
  secrets: z.array(catalogSecretSchema),
  vars: z.array(catalogVarSchema),
  postInstall: z.array(postInstallStepSchema),
  tokenPermissions: z.array(tokenPermissionSchema),
  /**
   * Resource settings the wrangler config cannot express, such as a Vectorize
   * index's dimensions and metric. Optional so manifests and artifacts written
   * before the field existed keep the same parsed shape.
   */
  resources: catalogResourcesSchema.optional(),
  /**
   * How the catalog's bump bot treats this entry. Optional for the same reason
   * as `resources`; omitted means a maintainer merges every bump.
   */
  bump: catalogBumpSchema.optional(),
});
export type CatalogManifest = z.infer<typeof catalogManifestSchema>;
