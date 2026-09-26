import { z } from "zod";
import {
  type CatalogVar,
  catalogManifestSchema,
  catalogVarOptions,
  entryWorkerNameSchema,
  gitShaSchema,
  ownerRepoSchema,
  vectorizeIndexConfigSchema,
} from "./catalog";
import { bindingEntryRefs, ENTRY_WORKER_REF_PATTERN, entryWorkerProblems } from "./workers";

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
 * Cloudflare Vite plugin does, pointing at the config it generates).
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
  mainModule: z.string().min(1),
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

/**
 * An artifact of one Worker. Its catalog manifest has no `install.workers`,
 * and no binding names another Worker of the entry.
 */
export const artifactManifestV1Schema = z
  .object({ format: z.literal(1), ...artifactManifestFields })
  .superRefine((manifest, ctx) => {
    if (manifest.catalog.install.workers !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["format"],
        message:
          "the catalog manifest declares several Workers (install.workers), so the artifact must be format 2 with a workers list",
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
    for (const message of entryWorkerProblems(manifest)) {
      ctx.addIssue({ code: "custom", path: ["workers"], message });
    }
  });

/** The full artifact manifest, `manifest.json`: format 1 (one Worker) or 2 (several). */
export const artifactManifestSchema = z.discriminatedUnion("format", [
  artifactManifestV1Schema,
  artifactManifestV2Schema,
]);
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type ArtifactManifestV1 = z.infer<typeof artifactManifestV1Schema>;
export type ArtifactManifestV2 = z.infer<typeof artifactManifestV2Schema>;
