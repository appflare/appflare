import { z } from "zod";
import { ACCESS_REQUIREMENT, usesAccessPlaceholders } from "./access";
import { assetsOnlyWorkerProblems } from "./assets-only";
import {
  type CatalogManifest,
  type CatalogVar,
  catalogManifestSchema,
  catalogVarOptions,
  entryWorkerNameSchema,
  type Plan,
  vectorizeIndexConfigSchema,
  vectorizeMetadataIndexesSchema,
} from "./catalog";
import { SERVICE_PROPS_REQUIREMENT } from "./manager-features";
import { PIPELINES_BINDING_TYPE } from "./pipelines";
import { r2LifecycleRuleSchema } from "./r2-lifecycle";
import { strictSchema } from "./strict";
import {
  appWorkers,
  bindingEntryRefs,
  ENTRY_WORKER_REF_PATTERN,
  entryWorkerProblems,
  workerManifest,
} from "./workers";
import {
  scheduledWorkflowPlanProblem,
  workflowSettingsByBindingSchema,
  workflowSettingsProblems,
} from "./workflow-settings";

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
 * Cloudflare cannot create one without them. The metadata indexes declared
 * there come along too, so the manager creates them with the index.
 */
export const vectorizeBindingSchema = z.looseObject({
  type: z.literal("vectorize"),
  name: z.string().min(1),
  ...vectorizeIndexConfigSchema.shape,
  metadataIndexes: vectorizeMetadataIndexesSchema.optional(),
});
export type VectorizeBinding = z.infer<typeof vectorizeBindingSchema>;

/**
 * An R2 binding. Besides its name it may carry the lifecycle rules the
 * packer copies from the catalog manifest's `resources.r2`, which the
 * manager sets on the bucket when it creates it.
 */
export const r2BucketBindingSchema = z.looseObject({
  type: z.literal("r2_bucket"),
  name: z.string().min(1),
  lifecycle: z.array(r2LifecycleRuleSchema).min(1).optional(),
});
export type R2BucketBinding = z.infer<typeof r2BucketBindingSchema>;

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
/**
 * A service binding's `props`, as wrangler sends them: a JSON object the
 * called Worker reads as `ctx.props`. Its strings may hold the placeholders a
 * var takes, which the manager fills in at every upload. An artifact with
 * props lists `"service-props"` in its catalog manifest's `requires`, since a
 * manager from before them refuses the binding.
 */
export const serviceBindingPropsSchema = z.record(z.string(), z.json());
export type ServiceBindingProps = z.infer<typeof serviceBindingPropsSchema>;

const selfServiceBindingShape = {
  type: z.literal("service"),
  name: z.string().min(1),
  service: z.literal(SELF_SERVICE),
  entrypoint: z.string().min(1).optional(),
  props: serviceBindingPropsSchema.optional(),
};
export const selfServiceBindingSchema = z.looseObject(selfServiceBindingShape);
export type SelfServiceBinding = z.infer<typeof selfServiceBindingSchema>;

/** A self binding with nothing but its name, optional entrypoint and optional props. */
const exactSelfServiceBindingSchema = z.strictObject(selfServiceBindingShape);

const STRICT_BINDING_TYPES: Readonly<Record<string, string>> = {
  vectorize: "a vectorize binding must record the index's dimensions and metric",
  json: "a json binding must record its value in `json`",
  r2_bucket: "an r2_bucket binding's lifecycle rules must be well formed",
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
  r2BucketBindingSchema,
  jsonVarBindingSchema,
  selfServiceBindingSchema,
  otherBindingSchema,
]);
export type WorkerBinding = z.infer<typeof workerBindingSchema>;

/**
 * Whether a binding is a service binding to the app's own Worker: service
 * `"self"`, with nothing but its name, an optional entrypoint and optional
 * `props`. A service binding that carries anything more (an `environment`)
 * is not one.
 */
export function isSelfServiceBinding(binding: WorkerBinding): binding is SelfServiceBinding {
  return binding.type === "service" && exactSelfServiceBindingSchema.safeParse(binding).success;
}

/**
 * A service binding to another Worker of the app's own catalog entry (an app
 * of several Workers, `install.workers`): the packer records that Worker as
 * `{{workerName:<name>}}` in place of its name in the wrangler config, and
 * the manager points the binding at the Worker it installed for that name.
 * Nothing but the name, an optional entrypoint and optional `props`, like a
 * self binding.
 */
const entryServiceBindingShape = {
  type: z.literal("service"),
  name: z.string().min(1),
  service: z.string().regex(ENTRY_WORKER_REF_PATTERN),
  entrypoint: z.string().min(1).optional(),
  props: serviceBindingPropsSchema.optional(),
};
export const entryServiceBindingSchema = z.looseObject(entryServiceBindingShape);
export type EntryServiceBinding = z.infer<typeof entryServiceBindingSchema>;
const exactEntryServiceBindingSchema = z.strictObject(entryServiceBindingShape);

/**
 * Whether a binding is a service binding to another Worker of the app's
 * entry (`{{workerName:<name>}}`), with nothing but its name, an optional
 * entrypoint and optional `props`. Whether the entry has that Worker is the
 * manifest's check.
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
    `(recorded as service "${SELF_SERVICE}", with nothing but an optional entrypoint and props) or to another ` +
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
 * Whether a parsed binding is an R2 binding, with its lifecycle rules typed.
 * Sound for anything `workerBindingSchema` parsed, which lets an
 * `r2_bucket` binding through only with well-formed rules.
 */
export function isR2BucketBinding(binding: WorkerBinding): binding is R2BucketBinding {
  return binding.type === "r2_bucket";
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
  /** The wrangler config the Worker was built from. */
  wranglerConfig: artifactWranglerConfigSchema,
  /**
   * The module the Worker starts from, one of `modules`. Omitted, with
   * `modules` empty, for a Worker that serves its static assets only (a
   * wrangler config with `assets` and no `main`; see `assets-only.ts`).
   */
  mainModule: z.string().min(1).optional(),
  compatibilityDate: z.iso.date(),
  compatibilityFlags: z.array(z.string()),
  modules: z.array(workerModuleSchema),
  bindings: z.array(workerBindingSchema),
  migrations: z.array(doMigrationSchema),
  crons: z.array(z.string()),
  /** Queues whose messages the Worker consumes. */
  queueConsumers: z.array(queueConsumerSchema).default([]),
  observability: workerObservabilitySchema,
  placement: workerPlacementSchema,
  limits: workerLimitsSchema,
  /**
   * Durable Object and entrypoint exports ({@link workerExportsSchema}).
   * Omitted when the config has none: wrangler then uploads none.
   */
  exports: workerExportsSchema.optional(),
  /** The config's `cache` block, uploaded as `cache_options`. Omitted when unset. */
  cacheOptions: workerCacheOptionsSchema.optional(),
  /**
   * The settings the wrangler config gives the Workflows the Worker defines,
   * by binding (`workflow-settings.ts`), sent when each is created or
   * updated. Omitted when none has any, and Cloudflare's defaults apply. A
   * manager from before this field strips it and creates the Workflows
   * with those defaults.
   */
  workflowSettings: workflowSettingsByBindingSchema.optional(),
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
  for (const consumer of worker.queueConsumers) {
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

/**
 * Static-assets router config (wrangler `assets` shape), sent as the upload's
 * `assets.config`. `_redirects` and `_headers` are the text of those files at
 * the root of the assets directory, which wrangler 4.136.2 sends there instead
 * of uploading them as assets. A manager that predates them keeps them too
 * (the object is loose) and sends them on.
 */
export const artifactAssetsConfigSchema = z.looseObject({
  html_handling: z.string().optional(),
  not_found_handling: z.string().optional(),
  run_worker_first: z.union([z.boolean(), z.array(z.string())]).optional(),
  _redirects: z.string().optional(),
  _headers: z.string().optional(),
});

/** The `assets` section of the artifact manifest. */
export const artifactAssetsSchema = z.object({
  config: artifactAssetsConfigSchema,
  binding: z.string().nullable(),
  files: z.array(assetFileSchema),
});
export type ArtifactAssets = z.infer<typeof artifactAssetsSchema>;

/**
 * The D1 SQL of one binding, as the packer records it from the wrangler
 * config and the catalog manifest's `resources.d1[binding]`:
 *
 * - `migrations`: the tracked migrations, in the order they run, recorded
 *   in `d1_migrations` by name;
 * - `schema`: files run on every install and update after the migrations,
 *   never recorded, in the order `resources.d1[binding].schema` lists them;
 * - `postDeploy`: migrations run once the new version serves all traffic
 *   (`postDeployMigrationsDir`), recorded like the others;
 * - `baseline`: one file with the database's whole current schema, run once
 *   on a new database before the migrations, which are then recorded as
 *   applied without running.
 */
export const artifactD1BindingSchema = z.object({
  migrations: z.array(d1MigrationFileSchema),
  schema: z.array(d1MigrationFileSchema).default([]),
  postDeploy: z.array(d1MigrationFileSchema).default([]),
  baseline: d1MigrationFileSchema.optional(),
});
export type ArtifactD1Binding = z.infer<typeof artifactD1BindingSchema>;

/** The D1 SQL of every binding, by binding name (shared by the Workers that bind it). */
export const artifactD1Schema = z.record(z.string().min(1), artifactD1BindingSchema);
export type ArtifactD1 = z.infer<typeof artifactD1Schema>;

/** Every D1 SQL file the artifact carries: migrations, schema files, post-deploy migrations, baselines. */
export function artifactD1Files(manifest: { d1: ArtifactD1 }): D1MigrationFile[] {
  return Object.values(manifest.d1).flatMap((binding) => [
    ...binding.migrations,
    ...binding.schema,
    ...binding.postDeploy,
    ...(binding.baseline === undefined ? [] : [binding.baseline]),
  ]);
}

/**
 * What is wrong with an artifact's D1 SQL, as sentences; empty when nothing
 * is. Schema files, post-deploy migrations and baselines come only from the
 * catalog manifest's `resources.d1`, so each must match what it declares
 * (the schema files by path, in its order). Post-deploy migrations are
 * recorded in `d1_migrations` beside the others, so a name may appear once
 * per database across both lists, or one of the files would never run.
 */
export function artifactD1Problems(manifest: {
  d1: ArtifactD1;
  catalog: Pick<CatalogManifest, "resources">;
}): string[] {
  const problems: string[] = [];
  const declared = manifest.catalog.resources?.d1 ?? {};
  const layout = (binding: string) =>
    Object.hasOwn(declared, binding) ? declared[binding] : undefined;
  const recorded = (binding: string) =>
    Object.hasOwn(manifest.d1, binding) ? manifest.d1[binding] : undefined;
  for (const [binding, sql] of Object.entries(manifest.d1)) {
    const want = layout(binding);
    if (sql.schema.length > 0) {
      if (want?.schema === undefined) {
        problems.push(
          `D1 schema files are recorded for ${binding}, but the catalog manifest declares none in resources.d1.${binding}.schema.`,
        );
      } else if (sql.schema.map((f) => f.name).join("\n") !== want.schema.join("\n")) {
        problems.push(
          `The D1 schema files recorded for ${binding} are not the ones resources.d1.${binding}.schema lists, in its order.`,
        );
      }
    }
    if (sql.postDeploy.length > 0 && want?.postDeployMigrationsDir === undefined) {
      problems.push(
        `Post-deploy D1 migrations are recorded for ${binding}, but the catalog manifest declares no resources.d1.${binding}.postDeployMigrationsDir.`,
      );
    }
    const tracked = new Set(sql.migrations.map((f) => f.name));
    for (const file of sql.postDeploy) {
      if (tracked.has(file.name)) {
        problems.push(
          `The D1 migration ${file.name} of ${binding} is both a migration and a post-deploy migration; both are recorded in d1_migrations by name, so their names must differ.`,
        );
      }
      tracked.add(file.name);
    }
    if (sql.baseline !== undefined) {
      if (want?.baseline === undefined) {
        problems.push(
          `A D1 baseline is recorded for ${binding}, but the catalog manifest declares no resources.d1.${binding}.baseline.`,
        );
      } else if (sql.baseline.name !== want.baseline) {
        problems.push(
          `The D1 baseline recorded for ${binding} is not the file resources.d1.${binding}.baseline names.`,
        );
      }
      if (sql.schema.length > 0) {
        problems.push(
          `${binding} has both a D1 baseline and schema files; the baseline runs once and schema files on every update, so an entry gives one or the other.`,
        );
      }
    }
  }
  for (const [binding, d1] of Object.entries(declared)) {
    const sql = recorded(binding);
    if (d1.schema !== undefined && (sql === undefined || sql.schema.length === 0)) {
      problems.push(
        `resources.d1.${binding}.schema lists schema files, but the artifact records none for ${binding}.`,
      );
    }
    if (d1.baseline !== undefined && sql?.baseline === undefined) {
      problems.push(
        `resources.d1.${binding}.baseline names a baseline, but the artifact records none for ${binding}.`,
      );
    }
  }
  return problems;
}

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

/**
 * The artifact format this version reads and writes. A format is raised
 * only for a field an older manager must not skip: one it would install the
 * app without, leaving it broken or exposed. An older manager refuses an
 * artifact of a format it does not know ({@link unknownArtifactFormatProblem})
 * and says to update Appflare. Anything an older manager may skip (it strips
 * keys it does not know) needs no new format. Formats 2 to
 * {@link LAST_EARLIER_ARTIFACT_FORMAT} were written by earlier versions of
 * Appflare, before this shape, so the next format is 7.
 */
export const LATEST_ARTIFACT_FORMAT = 1;

/**
 * The highest format earlier versions of Appflare wrote (they wrote 1 to 6,
 * in a shape this version no longer reads). An artifact of format 2 to 6 is
 * an old release, not one from a later Appflare.
 */
export const LAST_EARLIER_ARTIFACT_FORMAT = 6;
export type ArtifactFormat = typeof LATEST_ARTIFACT_FORMAT;

/**
 * The issue when the artifact's Workers bind something only Workers Paid
 * offers, or run a Workflow on a schedule, and its catalog manifest does not
 * say `plan: "paid"`, or null.
 */
function planIssue(manifest: {
  worker: ArtifactWorker;
  workers?: ReadonlyArray<{ worker: ArtifactWorker }> | undefined;
  catalog: Pick<CatalogManifest, "plan">;
}): { code: "custom"; path: string[]; message: string } | null {
  const workers = [manifest.worker, ...(manifest.workers ?? []).map((w) => w.worker)];
  const message =
    workersPaidBindingProblem(
      workers.flatMap((w) => w.bindings),
      manifest.catalog.plan,
    ) ?? scheduledWorkflowPlanProblem(workers, manifest.catalog.plan);
  return message === null ? null : { code: "custom", path: ["catalog", "plan"], message };
}

/** The issues of every Worker whose Workflow settings name no Workflow it defines. */
function workflowSettingsIssues(
  manifest: ArtifactManifest,
): Array<{ code: "custom"; path: Array<string | number>; message: string }> {
  return appWorkers(manifest).flatMap((w, index) =>
    workflowSettingsProblems(w.worker).map((message) => ({
      code: "custom" as const,
      path: w.primary
        ? ["worker", "workflowSettings"]
        : ["workers", index - 1, "worker", "workflowSettings"],
      message: w.name === null ? message : `The Worker "${w.name}": ${message}`,
    })),
  );
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
 * The full artifact manifest, `manifest.json`. `worker` and `assets` are the
 * app's Worker; for an app of several Workers (the catalog manifest's
 * `install.workers`) they are the primary Worker's, and `workers` lists every
 * other one in the catalog entry's order. The catalog manifest is embedded
 * as it was built, `source` included.
 */
export const artifactManifestSchema = z
  .object({
    format: z.literal(LATEST_ARTIFACT_FORMAT),
    /** The app's slug. */
    app: z.string().min(1),
    /** The version the release is published as (`<slug>@<version>`). */
    version: z.string().min(1),
    builtAt: z.iso.datetime(),
    builder: z.string().min(1),
    keyId: z.string().min(1),
    /** The app's Worker; for an app of several Workers, the primary one. */
    worker: artifactWorkerSchema,
    /** The static assets of `worker`. */
    assets: artifactAssetsSchema,
    /** The Workers besides the primary one, for an app of several; omitted for one Worker. */
    workers: z.array(artifactEntryWorkerSchema).min(1).optional(),
    /** The D1 SQL of every binding ({@link artifactD1BindingSchema}). */
    d1: artifactD1Schema,
    catalog: catalogManifestSchema,
  })
  .superRefine((manifest, ctx) => {
    // A wrangler config var filled in with an Access placeholder needs the
    // `"access"` requirement, as a catalog default does (./access.ts).
    if (!manifest.catalog.requires.includes(ACCESS_REQUIREMENT)) {
      for (const worker of [manifest.worker, ...(manifest.workers ?? []).map((w) => w.worker)]) {
        for (const binding of worker.bindings) {
          const text =
            binding.type === "plain_text" && typeof binding.text === "string"
              ? binding.text
              : binding.type === "json"
                ? JSON.stringify(binding.json ?? null)
                : "";
          if (usesAccessPlaceholders(text)) {
            ctx.addIssue({
              code: "custom",
              path: ["catalog", "requires"],
              message: `the wrangler config's var ${binding.name} uses an Access placeholder, so the catalog manifest's requires must list "access"`,
            });
          }
        }
      }
    }
    // Props on a service binding need a manager that sends them (./manager-features.ts).
    if (!manifest.catalog.requires.includes(SERVICE_PROPS_REQUIREMENT)) {
      for (const worker of [manifest.worker, ...(manifest.workers ?? []).map((w) => w.worker)]) {
        for (const binding of worker.bindings) {
          if (binding.type === "service" && binding.props !== undefined) {
            ctx.addIssue({
              code: "custom",
              path: ["catalog", "requires"],
              message: `the service binding ${binding.name} carries props, so the catalog manifest's requires must list "${SERVICE_PROPS_REQUIREMENT}"`,
            });
          }
        }
      }
    }
    for (const message of artifactD1Problems(manifest)) {
      ctx.addIssue({ code: "custom", path: ["d1"], message });
    }
    const plan = planIssue(manifest);
    if (plan !== null) ctx.addIssue(plan);
    for (const issue of assetsOnlyIssues(manifest)) ctx.addIssue(issue);
    for (const issue of workflowSettingsIssues(manifest)) ctx.addIssue(issue);
    const workers = manifest.workers;
    if (workers !== undefined) {
      for (const message of entryWorkerProblems({ ...manifest, workers })) {
        ctx.addIssue({ code: "custom", path: ["workers"], message });
      }
      return;
    }
    if (manifest.catalog.install.workers !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["workers"],
        message:
          "the catalog manifest declares several Workers (install.workers), so the artifact must list every Worker besides the primary one in workers",
      });
    }
    for (const binding of manifest.worker.bindings) {
      if (bindingEntryRefs(binding).length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["worker", "bindings"],
          message: `binding ${binding.name} names another Worker of the entry, but the artifact has one Worker`,
        });
      }
    }
  });
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

/**
 * The artifact manifest as the packer checks what it writes: every key
 * {@link artifactManifestSchema} would strip is refused, naming its path.
 * Managers read artifacts with {@link artifactManifestSchema}.
 */
export const strictArtifactManifestSchema = strictSchema(artifactManifestSchema);

/**
 * Where in the manager Appflare is updated, as the manager names the page.
 * The manager turns it into a link where it shows the sentence below.
 */
export const UPDATE_APPFLARE_PLACE = "Settings > Updates";

/**
 * Why a manifest's `format` is one this version cannot read, as a sentence,
 * or null when it can read it (or it has no numeric format, which the schema
 * then refuses on its own). A format from a later Appflare says to update
 * Appflare; one only earlier versions wrote (2 to
 * {@link LAST_EARLIER_ARTIFACT_FORMAT}) says the release must be packed
 * again, since no update reads it.
 */
export function unknownArtifactFormatProblem(json: unknown): string | null {
  if (typeof json !== "object" || json === null || !("format" in json)) return null;
  const format = (json as { format: unknown }).format;
  if (typeof format !== "number" || !Number.isInteger(format)) return null;
  if (format === LATEST_ARTIFACT_FORMAT) return null;
  if (format > LAST_EARLIER_ARTIFACT_FORMAT) {
    return `the artifact is format ${format}, and this version of Appflare reads format ${LATEST_ARTIFACT_FORMAT}; update Appflare in ${UPDATE_APPFLARE_PLACE}, then try again`;
  }
  if (format > LATEST_ARTIFACT_FORMAT) {
    return `the artifact is format ${format}: the app's release was built for an earlier version of Appflare and needs to be packed again by its catalog`;
  }
  return `the artifact is format ${format}, which no version of Appflare reads`;
}
