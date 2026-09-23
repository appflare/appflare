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
  workerName: z.string().min(1),
});
export type CatalogInstall = z.infer<typeof catalogInstallSchema>;

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
});
export type CatalogManifest = z.infer<typeof catalogManifestSchema>;
