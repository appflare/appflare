import { z } from "zod";
import { assetsOnlyWorkerProblems, isAssetsOnlyWorker } from "./assets-only";
import {
  type CatalogManifest,
  type CatalogVar,
  catalogManifestSchema,
  catalogVarOptions,
  entryWorkerNameSchema,
  gitShaSchema,
  ownerRepoSchema,
  type Plan,
  vectorizeIndexConfigSchema,
} from "./catalog";
import { PIPELINES_BINDING_TYPE } from "./pipelines";
import {
  appWorkers,
  bindingEntryRefs,
  ENTRY_WORKER_REF_PATTERN,
  entryWorkerProblems,
  workerManifest,
} from "./workers";

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
 * A wrangler config var whose value is not a string (an array, object,
 * number, boolean, or null). Wrangler uploads such vars as `json` bindings,
 * so the Worker reads the value itself rather than its JSON text; the packer
 * records them the same way and the manager uploads them as they are.
 * String vars stay `plain_text` bindings with a `text` field.
 */
export const jsonVarBindingSchema = z.looseObject({
  type: z.literal("json"),
  name: z.string().min(1),
  json: z.json(),
});
export type JsonVarBinding = z.infer<typeof jsonVarBindingSchema>;

/**
 * What an artifact records as the target of a service binding that points at
 * the app's own Worker. The packer writes it in place of the Worker's name in
 * the wrangler config, since an install may run under another name; the
 * manager replaces it with the install's own Worker name when it uploads.
 */
export const SELF_SERVICE = "self";

/**
 * A service binding to the app's own Worker, as OpenNext's
 * `WORKER_SELF_REFERENCE` is: the Worker calls itself, optionally at a named
 * entrypoint. The only service binding an app may have. A binding to any
 * other Worker is refused, because an app must never reach another install or
 * the manager (whose job units act with its account-wide API token).
 *
 * Loose like every binding shape here, so code can read any field of a
 * parsed binding; {@link isSelfServiceBinding} is what holds a self binding to
 * exactly these fields.
 */
const selfServiceBindingShape = {
  type: z.literal("service"),
  name: z.string().min(1),
  service: z.literal(SELF_SERVICE),
  entrypoint: z.string().min(1).optional(),
};
export const selfServiceBindingSchema = z.looseObject(selfServiceBindingShape);
export type SelfServiceBinding = z.infer<typeof selfServiceBindingSchema>;

/** A self binding with nothing but its name and optional entrypoint. */
const exactSelfServiceBindingSchema = z.strictObject(selfServiceBindingShape);

const STRICT_BINDING_TYPES: Readonly<Record<string, string>> = {
  vectorize: "a vectorize binding must record the index's dimensions and metric",
  json: "a json binding must record its value in `json`",
};

/**
 * Any other wrangler binding shape, with account-specific ids stripped by the
 * packer. Kept permissive on purpose: the packer records whatever wrangler
 * resolved. A `vectorize` or `json` binding never matches here, so one
 * without its required fields fails to parse instead of reaching the manager.
 * A `service` binding that is not a {@link selfServiceBindingSchema} parses
 * here, so an artifact with one still reads and the manager can say why it
 * refuses to install it ({@link serviceBindingProblem}).
 */
const otherBindingSchema = z.looseObject({
  type: z
    .string()
    .min(1)
    .superRefine((type, ctx) => {
      const message = Object.hasOwn(STRICT_BINDING_TYPES, type)
        ? STRICT_BINDING_TYPES[type]
        : undefined;
      if (message !== undefined) ctx.addIssue({ code: "custom", message });
    }),
  name: z.string().min(1),
});

/** A binding recorded in the artifact manifest. */
export const workerBindingSchema = z.union([
  vectorizeBindingSchema,
  jsonVarBindingSchema,
  selfServiceBindingSchema,
  otherBindingSchema,
]);
export type WorkerBinding = z.infer<typeof workerBindingSchema>;

/**
 * Whether a binding is a service binding to the app's own Worker: service
 * `"self"`, with nothing but its name and an optional entrypoint. A service
 * binding that carries anything more (an `environment`, `props`) is not one.
 */
export function isSelfServiceBinding(binding: WorkerBinding): binding is SelfServiceBinding {
  return binding.type === "service" && exactSelfServiceBindingSchema.safeParse(binding).success;
}

/**
 * A service binding to another Worker of the app's own catalog entry (an app
 * of several Workers, `install.workers`): the packer records that Worker as
 * `{{workerName:<name>}}` in place of its name in the wrangler config, and
 * the manager points the binding at the Worker it installed for that name.
 * Nothing but the name and an optional entrypoint, like a self binding.
 */
const entryServiceBindingShape = {
  type: z.literal("service"),
  name: z.string().min(1),
  service: z.string().regex(ENTRY_WORKER_REF_PATTERN),
  entrypoint: z.string().min(1).optional(),
};
export const entryServiceBindingSchema = z.looseObject(entryServiceBindingShape);
export type EntryServiceBinding = z.infer<typeof entryServiceBindingSchema>;
const exactEntryServiceBindingSchema = z.strictObject(entryServiceBindingShape);

/**
 * Whether a binding is a service binding to another Worker of the app's
 * entry (`{{workerName:<name>}}`), with nothing but its name and an optional
 * entrypoint. Whether the entry has that Worker is the manifest's check.
 */
export function isEntryServiceBinding(binding: WorkerBinding): binding is EntryServiceBinding {
  return binding.type === "service" && exactEntryServiceBindingSchema.safeParse(binding).success;
}

/**
 * Why a binding is a service binding an app may not have, as a sentence, or
 * null when it is not a service binding, is the app's binding to its own
 * Worker, or binds another Worker of the app's own entry. Any other service
 * binding would let the app call another Worker in the account: another
 * install, or the manager and the job units it serves with its account-wide
 * API token.
 */
export function serviceBindingProblem(binding: WorkerBinding): string | null {
  if (binding.type !== "service" || isSelfServiceBinding(binding)) return null;
  if (isEntryServiceBinding(binding)) return null;
  const target =
    typeof binding.service === "string" ? `the Worker "${binding.service}"` : "no Worker";
  return (
    `Service binding ${binding.name} points at ${target}; an app may bind only to its own Worker ` +
    `(recorded as service "${SELF_SERVICE}", with nothing but an optional entrypoint) or to another ` +
    "Worker of its own catalog entry, so it can never call another Worker in the account."
  );
}

/**
 * Whether a parsed binding is a `json` var, with its value typed. Sound for
 * anything `workerBindingSchema` parsed.
 */
export function isJsonVarBinding(binding: WorkerBinding): binding is JsonVarBinding {
  return binding.type === "json";
}

/**
 * Whether a parsed binding is a Vectorize binding, with its dimensions and
 * metric typed. Sound for anything `workerBindingSchema` parsed, which lets a
 * `vectorize` binding through only with both fields.
 */
export function isVectorizeBinding(binding: WorkerBinding): binding is VectorizeBinding {
  return binding.type === "vectorize";
}

/**
 * A queue the app uses, as the artifact names it. Queue names belong to the
 * account, so the install creates its own queue for each one and never uses
 * the upstream name as is:
 *
 * - `{ binding }`: the queue the app's producer binding of that name sends
 *   to; the install creates it for the binding.
 * - `{ name }`: a queue no producer binding sends to (typically a dead-letter
 *   queue), by its name in the app's wrangler config; the install creates
 *   `<workerName>-<name>` for it.
 */
export const queueRefSchema = z.union([
  z.strictObject({ binding: z.string().min(1) }),
  z.strictObject({ name: z.string().min(1).max(63) }),
]);
export type QueueRef = z.infer<typeof queueRefSchema>;

/**
 * A queue consumer: the app's Worker receives the queue's messages in its
 * `queue()` handler. Settings keep wrangler's `queues.consumers` names and
 * units (`max_batch_timeout` and `retry_delay` in seconds); omitted settings
 * take Cloudflare's defaults, and `max_concurrency: null` asks for the
 * platform's maximum.
 */
export const queueConsumerSchema = z.object({
  queue: queueRefSchema,
  max_batch_size: z.int().min(1).optional(),
  max_batch_timeout: z.number().min(0).optional(),
  max_retries: z.int().min(0).optional(),
  dead_letter_queue: queueRefSchema.optional(),
  max_concurrency: z.int().min(1).nullable().optional(),
  retry_delay: z.int().min(0).optional(),
});
export type QueueConsumer = z.infer<typeof queueConsumerSchema>;

/** A wrangler Durable Object migration entry. Permissive; wrangler owns the shape. */
export const doMigrationSchema = z.looseObject({ tag: z.string().min(1) });
export type DoMigration = z.infer<typeof doMigrationSchema>;

/**
 * Worker observability config as the wrangler config states it, or null when
 * unset. Recorded and uploaded verbatim, as wrangler uploads it. `enabled` is
 * optional because wrangler 4.136.2 accepts a config that turns on only part
 * of it (`[observability.logs] enabled = true` alone): its validation asks for
 * at least one of `enabled`, `logs.enabled`, `traces.enabled` or
 * `issues.enabled`, and it sends the section unchanged, so a missing
 * top-level `enabled` stays missing (wrangler reads it as off when comparing
 * with the deployed Worker).
 */
export const workerObservabilitySchema = z
  .looseObject({ enabled: z.boolean().optional() })
  .nullable();

/**
 * The Worker's `exports` as wrangler 4.136.2 uploads them: the wrangler
 * config's `exports` block keyed by class or entrypoint name, keeping only
 * the entries whose `type` is `durable-object` or `worker` (wrangler's
 * `partitionExports`). Declarative Durable Object exports replace
 * `migrations`: with any of them, wrangler sends no migrations. Loose, since
 * wrangler owns the shape; recorded and uploaded verbatim.
 */
export const workerExportsSchema = z.record(
  z.string().min(1),
  z.looseObject({ type: z.string().min(1) }),
);
export type WorkerExports = z.infer<typeof workerExportsSchema>;

/** The `type` of a Durable Object entry of {@link workerExportsSchema}. */
export const DURABLE_OBJECT_EXPORT_TYPE = "durable-object";

/** Whether `exports` declares any Durable Object class. */
export function hasDurableObjectExports(exports: WorkerExports | undefined): boolean {
  return Object.values(exports ?? {}).some((e) => e.type === DURABLE_OBJECT_EXPORT_TYPE);
}

/** The Durable Object entries of `exports`, without the entrypoint ones. */
export function durableObjectExports(exports: WorkerExports | null | undefined): WorkerExports {
  return Object.fromEntries(
    Object.entries(exports ?? {}).filter(([, e]) => e.type === DURABLE_OBJECT_EXPORT_TYPE),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Whether two Workers declare the same `exports`, whatever the key order. No
 * block and an empty one are the same: wrangler uploads neither.
 */
export function sameWorkerExports(
  a: WorkerExports | null | undefined,
  b: WorkerExports | null | undefined,
): boolean {
  return canonicalJson(a ?? {}) === canonicalJson(b ?? {});
}

/**
 * Whether two Workers' `exports` declare the same Durable Objects. Entrypoint
 * entries (`type: "worker"`) do not count: a change to them is a versioned
 * setting, not a change to the Worker's classes.
 */
export function sameDurableObjectExports(
  a: WorkerExports | null | undefined,
  b: WorkerExports | null | undefined,
): boolean {
  return sameWorkerExports(durableObjectExports(a), durableObjectExports(b));
}

/**
 * The wrangler config's `cache` block (`{ enabled, cross_version_cache? }`),
 * which wrangler uploads as the script's `cache_options`. Loose, like the
 * other settings wrangler owns.
 */
export const workerCacheOptionsSchema = z.looseObject({ enabled: z.boolean() });
export type WorkerCacheOptions = z.infer<typeof workerCacheOptionsSchema>;

/** Smart-placement config, or null. */
export const workerPlacementSchema = z.looseObject({}).nullable();

/** Worker limits config, or null. */
export const workerLimitsSchema = z.looseObject({}).nullable();

/**
 * Which wrangler config the packer built from, as paths relative to the
 * checkout (with `/` separators). `declared` is the catalog manifest's
 * `install.wranglerConfig`; `effective` is the config wrangler actually
 * deploys, which differs when the build left a redirect in
 * `.wrangler/deploy/config.json` beside the declared config (as the
 * Cloudflare Vite plugin does, pointing at the config it generates), and
 * when the catalog manifest's config patch was applied (the patched config,
 * `.appflare.wrangler.jsonc` beside the declared one).
 */
export const artifactWranglerConfigSchema = z.object({
  declared: z.string().min(1),
  effective: z.string().min(1),
});
export type ArtifactWranglerConfig = z.infer<typeof artifactWranglerConfigSchema>;

/** The `worker` section of the artifact manifest. */
export const artifactWorkerSchema = z.object({
  name: z.string().min(1),
  /**
   * The wrangler config the Worker was built from. Omitted by packers that
   * predate it, so older artifacts keep the shape they always had.
   */
  wranglerConfig: artifactWranglerConfigSchema.optional(),
  /**
   * The module the Worker starts from, one of `modules`. Omitted, with
   * `modules` empty, for a Worker that serves its static assets only (a
   * wrangler config with `assets` and no `main`; see `assets-only.ts`), which
   * only format 5 carries.
   */
  mainModule: z.string().min(1).optional(),
  compatibilityDate: z.iso.date(),
  compatibilityFlags: z.array(z.string()),
  modules: z.array(workerModuleSchema),
  bindings: z.array(workerBindingSchema),
  migrations: z.array(doMigrationSchema),
  crons: z.array(z.string()),
  /**
   * Queues whose messages the Worker consumes. Omitted when there are none,
   * so artifacts of apps without consumers keep the shape they always had.
   */
  queueConsumers: z.array(queueConsumerSchema).optional(),
  observability: workerObservabilitySchema,
  placement: workerPlacementSchema,
  limits: workerLimitsSchema,
  /**
   * Durable Object and entrypoint exports ({@link workerExportsSchema}).
   * Omitted when the config has none, so older artifacts keep their shape.
   */
  exports: workerExportsSchema.optional(),
  /** The config's `cache` block, uploaded as `cache_options`. Omitted when unset. */
  cacheOptions: workerCacheOptionsSchema.optional(),
});
export type ArtifactWorker = z.infer<typeof artifactWorkerSchema>;

/** How a queue reference reads in messages: `queue binding JOBS` or `queue "jobs-dlq"`. */
export function describeQueueRef(ref: QueueRef): string {
  return "binding" in ref ? `the queue of binding ${ref.binding}` : `the queue "${ref.name}"`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What is wrong with a Worker's queue consumers, as sentences; empty when
 * nothing is. A `{ binding }` reference must name one of the Worker's own
 * `queue` bindings, and a queue is consumed at most once.
 */
export function queueConsumerProblems(
  worker: Pick<ArtifactWorker, "bindings" | "queueConsumers">,
): string[] {
  const problems: string[] = [];
  const queueBindings = new Set(
    worker.bindings.filter((b) => b.type === "queue").map((b) => b.name),
  );
  const seen = new Set<string>();
  for (const consumer of worker.queueConsumers ?? []) {
    for (const ref of [consumer.queue, consumer.dead_letter_queue]) {
      if (ref !== undefined && "binding" in ref && !queueBindings.has(ref.binding)) {
        problems.push(
          `A queue consumer names the queue binding ${ref.binding}, but the Worker has no queue binding by that name.`,
        );
      }
    }
    const key = JSON.stringify(consumer.queue);
    if (seen.has(key)) {
      problems.push(`${capitalize(describeQueueRef(consumer.queue))} has more than one consumer.`);
    }
    seen.add(key);
  }
  return problems;
}

/**
 * Why `text` is not a JSON value, or null when it is. What a JSON var's
 * catalog `default` and the install form's value must be.
 */
export function jsonTextProblem(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    return `is not valid JSON (${error instanceof Error ? error.message : String(error)})`;
  }
}

/**
 * What is wrong with the catalog's vars for this Worker, as sentences; empty
 * when nothing is. A var the wrangler config gives a non-string value is a
 * `json` binding, so its catalog `default`, and each value of a `select`
 * var's `options`, must be JSON text.
 */
export function catalogVarProblems(
  bindings: readonly WorkerBinding[],
  vars: readonly CatalogVar[],
): string[] {
  const json = new Set(bindings.filter(isJsonVarBinding).map((b) => b.name));
  const problems: string[] = [];
  const why = (name: string) =>
    `the wrangler config gives ${name} a value that is not a string, so the Worker receives it as JSON.`;
  for (const v of vars) {
    if (!json.has(v.name)) continue;
    if (v.default !== undefined) {
      const problem = jsonTextProblem(v.default);
      if (problem !== null) {
        problems.push(`The default of the var ${v.name} ${problem}; ${why(v.name)}`);
      }
    }
    for (const option of catalogVarOptions(v) ?? []) {
      const problem = jsonTextProblem(option.value);
      if (problem !== null) {
        problems.push(
          `The option "${option.value}" of the var ${v.name} ${problem}; ${why(v.name)}`,
        );
      }
    }
  }
  return problems;
}

/**
 * The binding type of a Worker Loader (wrangler's `worker_loaders`), which
 * loads Workers at runtime. Cloudflare offers it only on Workers Paid.
 */
export const WORKER_LOADER_BINDING_TYPE = "worker_loader";

/**
 * Binding types Cloudflare offers only on Workers Paid, with what the
 * message calls them: a Worker Loader, and a Pipelines stream (Pipelines is
 * in open beta for Workers Paid accounts, developers.cloudflare.com/pipelines).
 */
const PAID_ONLY_BINDINGS: ReadonlyArray<readonly [string, string]> = [
  [WORKER_LOADER_BINDING_TYPE, "a Worker Loader"],
  [PIPELINES_BINDING_TYPE, "a Pipelines stream"],
];

/**
 * Why a Worker's bindings need the catalog manifest to say `plan: "paid"`, as
 * a sentence, or null when they do not or it does. A Worker Loader and a
 * Pipelines stream are available only on Workers Paid, so an app that binds
 * one is a Workers Paid app, and the install and update plan gates ask the
 * admin to confirm it.
 */
export function workersPaidBindingProblem(
  bindings: readonly WorkerBinding[],
  plan: Plan,
): string | null {
  if (plan === "paid") return null;
  for (const [type, what] of PAID_ONLY_BINDINGS) {
    const bound = bindings.filter((b) => b.type === type);
    if (bound.length === 0) continue;
    return (
      `the Worker binds ${what} (${bound.map((b) => b.name).join(", ")}), which Cloudflare offers only on Workers Paid; ` +
      'set "plan": "paid" in the catalog manifest'
    );
  }
  return null;
}

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

/** The D1 SQL an artifact carries, as the manager and the checks read it. */
export interface ArtifactD1 {
  d1Migrations: D1Migrations;
  d1Schema?: D1Migrations | undefined;
  d1PostDeploy?: D1Migrations | undefined;
  d1Baseline?: D1Migrations | undefined;
}

/**
 * Every D1 SQL file the artifact carries: migrations, schema files,
 * post-deploy migrations, baselines.
 */
export function artifactD1Files(manifest: ArtifactD1): D1MigrationFile[] {
  return [
    manifest.d1Migrations,
    manifest.d1Schema ?? {},
    manifest.d1PostDeploy ?? {},
    manifest.d1Baseline ?? {},
  ].flatMap((byBinding) => Object.values(byBinding).flat());
}

/**
 * What is wrong with an artifact's D1 SQL, as sentences; empty when nothing
 * is. Schema files and post-deploy migrations come only from the catalog
 * manifest's `resources.d1`, so each list must match what it declares (the
 * schema files by path, in its order). Post-deploy migrations are recorded in
 * `d1_migrations` beside the others, so a name may appear once per database
 * across both lists, or one of the files would never run.
 */
export function artifactD1Problems(
  manifest: ArtifactD1 & { catalog: Pick<CatalogManifest, "resources"> },
): string[] {
  const problems: string[] = [];
  const declared = manifest.catalog.resources?.d1 ?? {};
  const layout = (binding: string) =>
    Object.hasOwn(declared, binding) ? declared[binding] : undefined;
  const schema = manifest.d1Schema ?? {};
  for (const [binding, files] of Object.entries(schema)) {
    const want = layout(binding)?.schema;
    if (want === undefined) {
      problems.push(
        `D1 schema files are recorded for ${binding}, but the catalog manifest declares none in resources.d1.${binding}.schema.`,
      );
    } else if (files.map((f) => f.name).join("\n") !== want.join("\n")) {
      problems.push(
        `The D1 schema files recorded for ${binding} are not the ones resources.d1.${binding}.schema lists, in its order.`,
      );
    }
  }
  for (const [binding, d1] of Object.entries(declared)) {
    if (d1.schema !== undefined && !Object.hasOwn(schema, binding)) {
      problems.push(
        `resources.d1.${binding}.schema lists schema files, but the artifact records none for ${binding}.`,
      );
    }
  }
  for (const [binding, files] of Object.entries(manifest.d1PostDeploy ?? {})) {
    if (layout(binding)?.postDeployMigrationsDir === undefined) {
      problems.push(
        `Post-deploy D1 migrations are recorded for ${binding}, but the catalog manifest declares no resources.d1.${binding}.postDeployMigrationsDir.`,
      );
    }
    const migrations = Object.hasOwn(manifest.d1Migrations, binding)
      ? (manifest.d1Migrations[binding] ?? [])
      : [];
    const tracked = new Set(migrations.map((f) => f.name));
    for (const file of files) {
      if (tracked.has(file.name)) {
        problems.push(
          `The D1 migration ${file.name} of ${binding} is both a migration and a post-deploy migration; both are recorded in d1_migrations by name, so their names must differ.`,
        );
      }
      tracked.add(file.name);
    }
  }
  const baseline = manifest.d1Baseline ?? {};
  for (const [binding, files] of Object.entries(baseline)) {
    const want = layout(binding)?.baseline;
    if (want === undefined) {
      problems.push(
        `A D1 baseline is recorded for ${binding}, but the catalog manifest declares no resources.d1.${binding}.baseline.`,
      );
    } else if (files.length !== 1 || files[0]?.name !== want) {
      problems.push(
        `The D1 baseline recorded for ${binding} is not the one file resources.d1.${binding}.baseline names.`,
      );
    }
    if (Object.hasOwn(schema, binding)) {
      problems.push(
        `${binding} has both a D1 baseline and schema files; the baseline runs once and schema files on every update, so an entry gives one or the other.`,
      );
    }
  }
  for (const [binding, d1] of Object.entries(declared)) {
    if (d1.baseline !== undefined && !Object.hasOwn(baseline, binding)) {
      problems.push(
        `resources.d1.${binding}.baseline names a baseline, but the artifact records none for ${binding}.`,
      );
    }
  }
  return problems;
}

/** The upstream source the artifact was built from. */
export const artifactSourceSchema = z.object({
  repo: ownerRepoSchema,
  sha: gitShaSchema,
  ref: z.string().min(1),
});
export type ArtifactSource = z.infer<typeof artifactSourceSchema>;

/** The full artifact manifest, `manifest.json`. */
const artifactManifestFields = {
  app: z.string().min(1),
  version: z.string().min(1),
  source: artifactSourceSchema,
  builtAt: z.iso.datetime(),
  builder: z.string().min(1),
  keyId: z.string().min(1),
  /** The app's Worker; for an app of several Workers, the primary one. */
  worker: artifactWorkerSchema,
  /** The static assets of `worker`. */
  assets: artifactAssetsSchema,
  /** Every D1 migration of the app, by binding (shared by the Workers that bind it). */
  d1Migrations: d1MigrationsSchema,
  /**
   * SQL files run on every install and update after the migrations, never
   * recorded in `d1_migrations`, by binding, in the order the catalog lists
   * them (`resources.d1[binding].schema`). Omitted when there are none, so
   * artifacts without them keep the shape they always had.
   */
  d1Schema: d1MigrationsSchema.optional(),
  /**
   * Migrations run once the new version serves all traffic, recorded in
   * `d1_migrations` like the others (`resources.d1[binding].postDeployMigrationsDir`).
   * Omitted when there are none.
   */
  d1PostDeploy: d1MigrationsSchema.optional(),
  /**
   * One SQL file per binding with the database's whole current schema
   * (`resources.d1[binding].baseline`), run once on a new database before
   * the migrations, which are then recorded as applied without running.
   * Omitted when there is none.
   */
  d1Baseline: d1MigrationsSchema.optional(),
  catalog: catalogManifestSchema,
};

/**
 * One Worker of an app of several (see `workers.ts`) other than the primary
 * one: its name within the catalog entry (`install.workers[].name`), and its
 * own Worker section and static assets.
 */
export const artifactEntryWorkerSchema = z.object({
  name: entryWorkerNameSchema,
  worker: artifactWorkerSchema,
  assets: artifactAssetsSchema,
});
export type ArtifactEntryWorker = z.infer<typeof artifactEntryWorkerSchema>;

/** The artifact formats this version reads: 1 to {@link LATEST_ARTIFACT_FORMAT}. */
export const LATEST_ARTIFACT_FORMAT = 5;
export type ArtifactFormat = 1 | 2 | 3 | 4 | 5;

/** What decides an artifact's format, as a packer knows it before writing one. */
/** What of one Worker decides an artifact's format. */
export interface WorkerFormatFacts {
  exports?: Readonly<Record<string, unknown>> | undefined;
  cacheOptions?: unknown;
  /** The Worker's modules; none (an assets-only Worker) needs format 5. */
  modules?: readonly unknown[] | undefined;
}

export interface ArtifactFormatFacts {
  /** The primary Worker. */
  worker?: WorkerFormatFacts | undefined;
  /** The Workers besides the primary one; several Workers need format 2 or later. */
  workers?: ReadonlyArray<{ worker?: WorkerFormatFacts | undefined }> | undefined;
  d1Schema?: Record<string, readonly unknown[]> | undefined;
  d1PostDeploy?: Record<string, readonly unknown[]> | undefined;
  /** A D1 baseline needs format 5. */
  d1Baseline?: Record<string, readonly unknown[]> | undefined;
  /**
   * The catalog manifest: a Worker it keeps off workers.dev, or a D1 seed,
   * needs format 4.
   */
  catalog?:
    | {
        install?: {
          workers?: ReadonlyArray<{ workersDev?: boolean | undefined }> | undefined;
        };
        resources?: { d1?: Readonly<Record<string, { seed?: unknown }>> | undefined } | undefined;
      }
    | undefined;
}

/**
 * The oldest format that can carry an artifact, so every manager that can
 * install it correctly reads it and every older one refuses it rather than
 * install it without what it does not know:
 *
 * - 5: it carries a D1 baseline (`d1Baseline`), which a manager that reads
 *   only formats 1 to 4 would drop, running the migrations on an empty
 *   database instead, where they fail or leave the app without its tables;
 *   or a Worker has no code of its own and serves static assets only
 *   (no modules and no `mainModule`), which such a manager would fail to
 *   upload after creating the app's resources;
 * - 4: its catalog manifest keeps a Worker off workers.dev
 *   (`install.workers[].workersDev: false`), which a manager that reads only
 *   formats 1 to 3 would not know and would put on its workers.dev URL,
 *   reachable from the internet; or it seeds a D1 database
 *   (`resources.d1[binding].seed`), which such a manager's schema strips,
 *   leaving the app without its first admin, or with the default admin an
 *   upstream seed file adds;
 * - 3: it carries D1 schema files or post-deploy migrations (`d1Schema`,
 *   `d1PostDeploy`), which a manager that reads only formats 1 and 2 would
 *   drop without a word, leaving the app without its tables; or a Worker
 *   with `exports` or `cacheOptions`, which such a manager would not upload,
 *   leaving the app without the Durable Objects its exports declare;
 * - 2: it has several Workers (`workers`);
 * - 1: anything else.
 *
 * A field that older managers must not skip goes here, and moves the
 * artifacts that carry it to a new format.
 */
export function artifactFormatFor(facts: ArtifactFormatFacts): ArtifactFormat {
  const has = (lists: Record<string, readonly unknown[]> | undefined) =>
    lists !== undefined && Object.values(lists).some((files) => files.length > 0);
  const workerNeeds3 = (w: WorkerFormatFacts | undefined) =>
    w !== undefined &&
    ((w.exports !== undefined && Object.keys(w.exports).length > 0) ||
      w.cacheOptions !== undefined);
  if (has(facts.d1Baseline)) return 5;
  const assetsOnly = (w: WorkerFormatFacts | undefined) =>
    w?.modules !== undefined && isAssetsOnlyWorker({ modules: w.modules });
  if (assetsOnly(facts.worker) || (facts.workers ?? []).some((w) => assetsOnly(w.worker))) {
    return 5;
  }
  if (facts.catalog?.install?.workers?.some((w) => w.workersDev === false) === true) return 4;
  const d1 = facts.catalog?.resources?.d1 ?? {};
  if (Object.values(d1).some((layout) => layout.seed !== undefined)) return 4;
  if (has(facts.d1Schema) || has(facts.d1PostDeploy)) return 3;
  if (workerNeeds3(facts.worker) || (facts.workers ?? []).some((w) => workerNeeds3(w.worker))) {
    return 3;
  }
  if (facts.workers !== undefined && facts.workers.length > 0) return 2;
  return 1;
}

/** Why an artifact of `format` cannot carry what it does, or null when it can. */
function formatProblem(manifest: ArtifactFormatFacts & { format: number }): string | null {
  const needed = artifactFormatFor(manifest);
  if (needed <= manifest.format) return null;
  return `the artifact needs format ${needed} for what it carries (D1 schema files, post-deploy migrations, a Worker's exports or cache block, a Worker kept off workers.dev, D1 seed statements, a D1 baseline, a Worker of static assets only); a manager that reads only format ${manifest.format} would install it without them`;
}

/**
 * What is wrong with an artifact of one Worker, as sentences: its catalog
 * manifest must not declare `install.workers`, and no binding may name
 * another Worker of the entry.
 */
function singleWorkerProblems(manifest: {
  worker: ArtifactWorker;
  catalog: Pick<CatalogManifest, "install">;
}): Array<{ path: string[]; message: string }> {
  const problems: Array<{ path: string[]; message: string }> = [];
  if (manifest.catalog.install.workers !== undefined) {
    problems.push({
      path: ["format"],
      message:
        "the catalog manifest declares several Workers (install.workers), so the artifact must be format 2 or later with a workers list",
    });
  }
  for (const binding of manifest.worker.bindings) {
    if (bindingEntryRefs(binding).length > 0) {
      problems.push({
        path: ["worker", "bindings"],
        message: `binding ${binding.name} names another Worker of the entry, but the artifact has one Worker`,
      });
    }
  }
  return problems;
}

/**
 * The issue when the artifact's Workers bind something only Workers Paid
 * offers and its catalog manifest does not say `plan: "paid"`, or null.
 */
function planIssue(manifest: {
  worker: ArtifactWorker;
  workers?: ReadonlyArray<{ worker: ArtifactWorker }> | undefined;
  catalog: Pick<CatalogManifest, "plan">;
}): { code: "custom"; path: string[]; message: string } | null {
  const bindings = [manifest.worker, ...(manifest.workers ?? []).map((w) => w.worker)].flatMap(
    (w) => w.bindings,
  );
  const message = workersPaidBindingProblem(bindings, manifest.catalog.plan);
  return message === null ? null : { code: "custom", path: ["catalog", "plan"], message };
}

/**
 * The issues of every Worker that cannot be uploaded as recorded
 * ({@link assetsOnlyWorkerProblems}), each checked against the catalog
 * secrets and vars that go to it.
 */
function assetsOnlyIssues(
  manifest: ArtifactManifest,
): Array<{ code: "custom"; path: Array<string | number>; message: string }> {
  return appWorkers(manifest).flatMap((w, index) => {
    const { catalog } = workerManifest(manifest, w);
    const subject = w.name === null ? "The Worker" : `The Worker "${w.name}"`;
    return assetsOnlyWorkerProblems(w.worker, w.assets, catalog, subject).map((message) => ({
      code: "custom" as const,
      path: w.primary ? ["worker"] : ["workers", index - 1],
      message,
    }));
  });
}

/**
 * An artifact of one Worker. Its catalog manifest has no `install.workers`,
 * and no binding names another Worker of the entry.
 */
export const artifactManifestV1Schema = z
  .object({ format: z.literal(1), ...artifactManifestFields })
  .superRefine((manifest, ctx) => {
    for (const problem of singleWorkerProblems(manifest)) {
      ctx.addIssue({ code: "custom", ...problem });
    }
    const format = formatProblem(manifest);
    if (format !== null) ctx.addIssue({ code: "custom", path: ["format"], message: format });
    for (const message of artifactD1Problems(manifest)) {
      ctx.addIssue({ code: "custom", path: ["d1Migrations"], message });
    }
    const plan = planIssue(manifest);
    if (plan !== null) ctx.addIssue(plan);
    for (const issue of assetsOnlyIssues(manifest)) ctx.addIssue(issue);
  });

/**
 * An artifact of several Workers (format 2): `worker` and `assets` are the
 * primary Worker's, as in format 1, and `workers` lists every other one in
 * the catalog entry's order. A manager that reads only format 1 refuses it
 * rather than installing the primary Worker alone.
 */
export const artifactManifestV2Schema = z
  .object({
    format: z.literal(2),
    ...artifactManifestFields,
    workers: z.array(artifactEntryWorkerSchema).min(1),
  })
  .superRefine((manifest, ctx) => {
    const format = formatProblem(manifest);
    if (format !== null) ctx.addIssue({ code: "custom", path: ["format"], message: format });
    for (const message of artifactD1Problems(manifest)) {
      ctx.addIssue({ code: "custom", path: ["d1Migrations"], message });
    }
    for (const message of entryWorkerProblems(manifest)) {
      ctx.addIssue({ code: "custom", path: ["workers"], message });
    }
    const plan = planIssue(manifest);
    if (plan !== null) ctx.addIssue(plan);
    for (const issue of assetsOnlyIssues(manifest)) ctx.addIssue(issue);
  });

/**
 * An artifact that carries what managers reading formats 1 and 2 would skip
 * (see {@link artifactFormatFor}): one Worker, or several with `workers` as
 * in format 2. Those managers refuse it, since their schema knows no format 3.
 * Formats 4 and 5 have the same shape; managers that read only the formats
 * before them refuse them in the same way.
 */
export const artifactManifestV3Schema = z
  .object({
    format: z.literal([3, 4, 5]),
    ...artifactManifestFields,
    workers: z.array(artifactEntryWorkerSchema).min(1).optional(),
  })
  .superRefine((manifest, ctx) => {
    const format = formatProblem(manifest);
    if (format !== null) ctx.addIssue({ code: "custom", path: ["format"], message: format });
    for (const message of artifactD1Problems(manifest)) {
      ctx.addIssue({ code: "custom", path: ["d1Migrations"], message });
    }
    const plan = planIssue(manifest);
    if (plan !== null) ctx.addIssue(plan);
    for (const issue of assetsOnlyIssues(manifest)) ctx.addIssue(issue);
    const workers = manifest.workers;
    if (workers === undefined) {
      for (const problem of singleWorkerProblems(manifest)) {
        ctx.addIssue({ code: "custom", ...problem });
      }
      return;
    }
    for (const message of entryWorkerProblems({ ...manifest, workers })) {
      ctx.addIssue({ code: "custom", path: ["workers"], message });
    }
  });

/**
 * The full artifact manifest, `manifest.json`: format 1 (one Worker), 2
 * (several), 3 (either, with D1 files older managers do not know), 4 (as
 * 3, with a Worker kept off workers.dev or D1 seed statements), or 5 (as 4,
 * with a D1 baseline or a Worker of static assets only).
 */
export const artifactManifestSchema = z.discriminatedUnion("format", [
  artifactManifestV1Schema,
  artifactManifestV2Schema,
  artifactManifestV3Schema,
]);
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type ArtifactManifestV1 = z.infer<typeof artifactManifestV1Schema>;
export type ArtifactManifestV2 = z.infer<typeof artifactManifestV2Schema>;
export type ArtifactManifestV3 = z.infer<typeof artifactManifestV3Schema>;

/**
 * Why a manifest's `format` is one this version cannot read, as a sentence
 * that says to update Appflare, or null when it can read it (or it has no
 * numeric format, which the schema then refuses on its own).
 */
export function unknownArtifactFormatProblem(json: unknown): string | null {
  if (typeof json !== "object" || json === null || !("format" in json)) return null;
  const format = (json as { format: unknown }).format;
  if (typeof format !== "number" || !Number.isInteger(format)) return null;
  if (format >= 1 && format <= LATEST_ARTIFACT_FORMAT) return null;
  return format > LATEST_ARTIFACT_FORMAT
    ? `the artifact is format ${format}, and this version of Appflare reads formats 1 to ${LATEST_ARTIFACT_FORMAT}; update Appflare in Settings, then try again`
    : `the artifact is format ${format}, which no version of Appflare reads`;
}
