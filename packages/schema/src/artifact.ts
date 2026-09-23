import { z } from "zod";
import {
  catalogManifestSchema,
  gitShaSchema,
  ownerRepoSchema,
  vectorizeIndexConfigSchema,
} from "./catalog";

/**
 * Schemas for the machine-generated artifact manifest `manifest.json`.
 * It embeds the catalog manifest verbatim so the signed
 * artifact carries the secrets/vars form, and records byte offsets so the
 * manager can Range-fetch each file straight from the release asset.
 */

/** 64-character lowercase hex SHA-256 digest. */
export const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a 64-character lowercase hex SHA-256");

/**
 * 32-character lowercase hex BLAKE3 asset hash, exactly wrangler's
 * `assets-upload-session` id (`blake3(base64(contents) + extension)[:32]`).
 * Computed by `@appflare/cf-api`'s `assetHash`.
 */
export const assetHashSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, "must be a 32-character lowercase hex BLAKE3 asset hash");

/** Byte offset of a file's data inside the STORE zip. */
export const offsetSchema = z.int().min(0);

/** Byte length of a file. */
export const sizeSchema = z.int().min(0);

/** Fields shared by every file recorded in the manifest, addressable via Range. */
const fileEntryFields = {
  path: z.string().min(1),
  size: sizeSchema,
  sha256: sha256Schema,
  offset: offsetSchema,
};

/** Worker module type as emitted by wrangler `--dry-run`. */
export const moduleTypeSchema = z.enum([
  "esm",
  "commonjs",
  "text",
  "data",
  "compiled-wasm",
  "python",
  "python-requirement",
]);
export type ModuleType = z.infer<typeof moduleTypeSchema>;

/** A bundled Worker module. */
export const workerModuleSchema = z.object({
  name: z.string().min(1),
  type: moduleTypeSchema,
  ...fileEntryFields,
});
export type WorkerModule = z.infer<typeof workerModuleSchema>;

/** A static asset file, keyed by its served route. */
export const assetFileSchema = z.object({
  route: z.string().min(1),
  // Two hashes on purpose: `sha256` verifies the integrity of a Range slice read
  // from the zip; `hash` is wrangler's BLAKE3 asset id, which the manager sends
  // when it opens the assets-upload-session — before it has any file bytes.
  hash: assetHashSchema,
  ...fileEntryFields,
});
export type AssetFile = z.infer<typeof assetFileSchema>;

/** A D1 migration SQL file. */
export const d1MigrationFileSchema = z.object({
  name: z.string().min(1),
  ...fileEntryFields,
});
export type D1MigrationFile = z.infer<typeof d1MigrationFileSchema>;

/**
 * A Vectorize binding. Besides its name it carries the index's dimensions and
 * metric, which the packer copies from the catalog manifest's
 * `resources.vectorize`: the manager creates the index before binding it, and
 * Cloudflare cannot create one without them.
 */
export const vectorizeBindingSchema = z.looseObject({
  type: z.literal("vectorize"),
  name: z.string().min(1),
  ...vectorizeIndexConfigSchema.shape,
});
export type VectorizeBinding = z.infer<typeof vectorizeBindingSchema>;

/**
 * Any other wrangler binding shape, with account-specific ids stripped by the
 * packer. Kept permissive on purpose: the packer records whatever wrangler
 * resolved. A `vectorize` binding never matches here, so one without its
 * index shape fails to parse instead of reaching the manager.
 */
const otherBindingSchema = z.looseObject({
  type: z
    .string()
    .min(1)
    .refine((type) => type !== "vectorize", {
      error: "a vectorize binding must record the index's dimensions and metric",
    }),
  name: z.string().min(1),
});

/** A binding recorded in the artifact manifest. */
export const workerBindingSchema = z.union([vectorizeBindingSchema, otherBindingSchema]);
export type WorkerBinding = z.infer<typeof workerBindingSchema>;

/**
 * Whether a parsed binding is a Vectorize binding, with its dimensions and
 * metric typed. Sound for anything `workerBindingSchema` parsed, which lets a
 * `vectorize` binding through only with both fields.
 */
export function isVectorizeBinding(binding: WorkerBinding): binding is VectorizeBinding {
  return binding.type === "vectorize";
}

/** A wrangler Durable Object migration entry. Permissive; wrangler owns the shape. */
export const doMigrationSchema = z.looseObject({ tag: z.string().min(1) });
export type DoMigration = z.infer<typeof doMigrationSchema>;

/** Worker observability config, or null when unset. */
export const workerObservabilitySchema = z.looseObject({ enabled: z.boolean() }).nullable();

/** Smart-placement config, or null. */
export const workerPlacementSchema = z.looseObject({}).nullable();

/** Worker limits config, or null. */
export const workerLimitsSchema = z.looseObject({}).nullable();

/** The `worker` section of the artifact manifest. */
export const artifactWorkerSchema = z.object({
  name: z.string().min(1),
  mainModule: z.string().min(1),
  compatibilityDate: z.iso.date(),
  compatibilityFlags: z.array(z.string()),
  modules: z.array(workerModuleSchema),
  bindings: z.array(workerBindingSchema),
  migrations: z.array(doMigrationSchema),
  crons: z.array(z.string()),
  observability: workerObservabilitySchema,
  placement: workerPlacementSchema,
  limits: workerLimitsSchema,
});
export type ArtifactWorker = z.infer<typeof artifactWorkerSchema>;

/** Static-assets router config (wrangler `assets` shape). */
export const artifactAssetsConfigSchema = z.looseObject({
  html_handling: z.string().optional(),
  not_found_handling: z.string().optional(),
  run_worker_first: z.union([z.boolean(), z.array(z.string())]).optional(),
});

/** The `assets` section of the artifact manifest. */
export const artifactAssetsSchema = z.object({
  config: artifactAssetsConfigSchema,
  binding: z.string().nullable(),
  files: z.array(assetFileSchema),
});
export type ArtifactAssets = z.infer<typeof artifactAssetsSchema>;

/** D1 migration files grouped by binding name. */
export const d1MigrationsSchema = z.record(z.string(), z.array(d1MigrationFileSchema));
export type D1Migrations = z.infer<typeof d1MigrationsSchema>;

/** The upstream source the artifact was built from. */
export const artifactSourceSchema = z.object({
  repo: ownerRepoSchema,
  sha: gitShaSchema,
  ref: z.string().min(1),
});
export type ArtifactSource = z.infer<typeof artifactSourceSchema>;

/** The full artifact manifest, `manifest.json`. */
export const artifactManifestSchema = z.object({
  format: z.literal(1),
  app: z.string().min(1),
  version: z.string().min(1),
  source: artifactSourceSchema,
  builtAt: z.iso.datetime(),
  builder: z.string().min(1),
  keyId: z.string().min(1),
  worker: artifactWorkerSchema,
  assets: artifactAssetsSchema,
  d1Migrations: d1MigrationsSchema,
  catalog: catalogManifestSchema,
});
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
