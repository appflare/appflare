import { z } from "zod";
import { configRelativePathSchema, PATCHED_WRANGLER_CONFIG } from "./config-patch.ts";
import { isUnsupportedWranglerSection } from "./wrangler-sections.ts";

/**
 * A catalog entry's `install.wranglerConfigInline` (and
 * `install.workers[].wranglerConfigInline`): the wrangler config of an app
 * whose repository ships none, carried in the signed catalog manifest. The
 * packer writes it as `.appflare.wrangler.jsonc` in the directory the
 * entry's `wranglerConfig` names, with the Worker's `name` added, and reads
 * it like any other config.
 *
 * The config is allowlisted by key and by the fields of each binding, so it
 * can never name another account's resources: storage bindings carry no ids
 * (the install provisions each one), Durable Object and Workflow bindings
 * point at classes of the same Worker, and Durable Objects are SQLite-backed.
 * A repository that has a config of its own is changed with a config patch
 * instead; the packer refuses an inline config beside one.
 *
 * This module imports nothing but zod and modules that import nothing, for
 * the same reason as `config-patch.ts`.
 */

/**
 * The `info().features` entry of a sandbox Worker whose packer writes an
 * entry's inline wrangler config. An older one would find no config to read.
 */
export const SANDBOX_FEATURE_WRANGLER_CONFIG_INLINE = "wrangler-config-inline";

/** The top-level keys an inline config may set. */
export const WRANGLER_CONFIG_INLINE_KEYS = [
  "main",
  "compatibility_date",
  "compatibility_flags",
  "assets",
  "vars",
  "triggers",
  "observability",
  "placement",
  "kv_namespaces",
  "r2_buckets",
  "d1_databases",
  "queues",
  "durable_objects",
  "migrations",
  "workflows",
  "services",
  "ai",
  "browser",
  "images",
  "version_metadata",
] as const;
export type WranglerConfigInlineKey = (typeof WRANGLER_CONFIG_INLINE_KEYS)[number];

/** Why a key outside {@link WRANGLER_CONFIG_INLINE_KEYS} is refused, for the keys an author might reach for. */
const REFUSED_KEY_REASONS = new Map<string, string>([
  ["__proto__", "it is not a wrangler config key"],
  ["name", "the packer names the Worker after install.workerName"],
  ["account_id", "the account is the one the app is installed in"],
  ["env", "the packer reads the config's top level, not an environment"],
  ["routes", "routes belong to the install, not the artifact"],
  ["route", "routes belong to the install, not the artifact"],
  ["workers_dev", "the install decides where the Worker answers"],
  ["build", "name the build step in install.buildCommand instead"],
]);

const bindingNameSchema = z
  .string()
  .min(1)
  .describe("The binding's name, as the Worker reads it from `env`.");

/**
 * A binding entry of `list` that may hold only `shape`: any other key (an
 * `id`, `database_id`, `bucket_name`, `script_name`) is refused with a
 * message saying why.
 */
function entrySchema<Shape extends z.ZodRawShape>(list: string, shape: Shape, why: string) {
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `an inline config's ${list} entry takes only ${Object.keys(shape).join(", ")}: ${why}`
        : undefined,
  });
}

const NO_IDS = "ids are left out, so the install provisions the resource";

/** `{ binding }`, for the bindings that name nothing but themselves. */
function soleBinding(key: string) {
  return entrySchema(key, { binding: bindingNameSchema }, "it binds a service by name only");
}

const assetsSchema = z
  .strictObject({
    directory: configRelativePathSchema.describe(
      "The directory of static assets, relative to the config, for example `dist/client`.",
    ),
    binding: bindingNameSchema
      .describe("The binding the Worker fetches its assets through, for example `ASSETS`.")
      .optional(),
    html_handling: z
      .enum(["auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", "none"])
      .describe("How requests for HTML pages match files, as wrangler's `html_handling`.")
      .optional(),
    not_found_handling: z
      .enum(["single-page-application", "404-page", "none"])
      .describe("What a request that matches no file gets, as wrangler's `not_found_handling`.")
      .optional(),
    run_worker_first: z
      .union([z.boolean(), z.array(z.string().min(1))])
      .describe("Whether the Worker runs before assets are served, or for which paths.")
      .optional(),
  })
  .describe("Static assets the Worker serves, as wrangler's `assets`.");

const classNameSchema = z.string().min(1).describe("A Durable Object class the Worker exports.");

const migrationSchema = z
  .strictObject(
    {
      tag: z.string().min(1).describe("The migration's tag, unique within the list."),
      new_sqlite_classes: z
        .array(classNameSchema)
        .describe("Classes this migration creates, SQLite-backed.")
        .optional(),
      renamed_classes: z
        .array(
          z
            .strictObject({
              from: classNameSchema.describe("The class's name before."),
              to: classNameSchema.describe("The class's name after."),
            })
            .describe("One class renamed."),
        )
        .describe("Classes this migration renames.")
        .optional(),
      deleted_classes: z
        .array(classNameSchema)
        .describe("Classes this migration deletes, with their data.")
        .optional(),
    },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? "an inline config's migration takes only tag, new_sqlite_classes, renamed_classes and " +
            "deleted_classes: its Durable Objects are SQLite-backed, which the Free plan requires"
          : undefined,
    },
  )
  .describe("One Durable Object migration; new classes are SQLite-backed.");

const samplingRateSchema = z
  .number()
  .min(0)
  .max(1)
  .describe("The share of requests recorded, from 0 to 1.");

const wranglerConfigInlineShape = {
  main: configRelativePathSchema
    .describe(
      "The Worker's entrypoint, relative to the config, for example `src/index.ts`. Omitted " +
        "for a Worker of static assets only.",
    )
    .optional(),
  compatibility_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "compatibility_date is a date, YYYY-MM-DD")
    .describe("The compatibility date the app is tested against."),
  compatibility_flags: z
    .array(z.string().min(1))
    .describe("Compatibility flags, for example `nodejs_compat`.")
    .optional(),
  assets: assetsSchema.optional(),
  vars: z
    .record(z.string().min(1), z.json())
    .describe("Plain variables: a string, or any JSON value.")
    .optional(),
  triggers: z
    .strictObject({
      crons: z.array(z.string().min(1)).describe("Cron expressions the Worker runs on."),
    })
    .describe("Cron triggers.")
    .optional(),
  observability: z
    .strictObject({
      enabled: z.boolean().describe("Whether Workers Logs record the Worker.").optional(),
      head_sampling_rate: samplingRateSchema.optional(),
      logs: z
        .strictObject({
          enabled: z.boolean().describe("Whether logs are recorded.").optional(),
          head_sampling_rate: samplingRateSchema.optional(),
          invocation_logs: z
            .boolean()
            .describe("Whether a log line is recorded for each invocation.")
            .optional(),
        })
        .describe("Settings for logs alone.")
        .optional(),
      traces: z
        .strictObject({
          enabled: z.boolean().describe("Whether traces are recorded.").optional(),
          head_sampling_rate: samplingRateSchema.optional(),
        })
        .describe("Settings for traces.")
        .optional(),
    })
    .describe("Workers Logs and traces, as wrangler's `observability`.")
    .optional(),
  placement: z
    .strictObject({
      mode: z.enum(["off", "smart"]).describe("`smart` for Smart Placement, or `off`."),
      hint: z
        .string()
        .min(1)
        .describe("A region to place the Worker near, which makes the placement smart.")
        .optional(),
    })
    .describe("Smart Placement: `smart`, with an optional region hint, or `off`.")
    .optional(),
  kv_namespaces: z
    .array(entrySchema("kv_namespaces", { binding: bindingNameSchema }, NO_IDS))
    .describe("KV namespaces, by binding only: the install creates each one.")
    .optional(),
  r2_buckets: z
    .array(entrySchema("r2_buckets", { binding: bindingNameSchema }, NO_IDS))
    .describe("R2 buckets, by binding only: the install creates each one.")
    .optional(),
  d1_databases: z
    .array(
      entrySchema(
        "d1_databases",
        {
          binding: bindingNameSchema,
          database_name: z
            .string()
            .min(1)
            .describe("The database's name upstream; the install names its own.")
            .optional(),
          migrations_dir: configRelativePathSchema
            .describe("The directory of the database's migrations, relative to the config.")
            .optional(),
          migrations_table: z
            .string()
            .min(1)
            .describe("The table that records applied migrations.")
            .optional(),
        },
        NO_IDS,
      ),
    )
    .describe("D1 databases, without ids: the install creates each one.")
    .optional(),
  queues: z
    .strictObject({
      producers: z
        .array(
          entrySchema(
            "queues.producers",
            {
              binding: bindingNameSchema,
              queue: z
                .string()
                .min(1)
                .describe("The queue's name upstream; the install creates one of its own."),
              delivery_delay: z
                .int()
                .min(0)
                .describe("Seconds before a message sent is delivered.")
                .optional(),
            },
            "the install creates a queue of its own for each",
          ),
        )
        .describe("Queues the Worker sends to.")
        .optional(),
      consumers: z
        .array(
          entrySchema(
            "queues.consumers",
            {
              queue: z.string().min(1).describe("The queue consumed, by its name upstream."),
              max_batch_size: z.int().min(1).describe("Most messages in a batch.").optional(),
              max_batch_timeout: z
                .number()
                .min(0)
                .describe("Most seconds to wait for a batch to fill.")
                .optional(),
              max_retries: z.int().min(0).describe("Retries of a failed message.").optional(),
              dead_letter_queue: z
                .string()
                .min(1)
                .describe("The queue failed messages go to, by its name upstream.")
                .optional(),
              max_concurrency: z.int().min(1).describe("Most batches consumed at once.").optional(),
              retry_delay: z
                .int()
                .min(0)
                .describe("Seconds before a message is retried.")
                .optional(),
            },
            "the Worker consumes its own queues",
          ),
        )
        .describe("Queues the Worker consumes.")
        .optional(),
    })
    .describe("Queue producers and consumers; the install creates each queue.")
    .optional(),
  durable_objects: z
    .strictObject({
      bindings: z
        .array(
          entrySchema(
            "durable_objects.bindings",
            {
              name: bindingNameSchema,
              class_name: classNameSchema.describe(
                "The class, created by this config's migrations.",
              ),
            },
            "the class is one of this Worker's, declared in its migrations",
          ),
        )
        .describe("Durable Object bindings, each to a class of this Worker."),
    })
    .describe("Durable Object bindings.")
    .optional(),
  migrations: z.array(migrationSchema).describe("Durable Object migrations, in order.").optional(),
  workflows: z
    .array(
      entrySchema(
        "workflows",
        {
          binding: bindingNameSchema,
          name: z.string().min(1).describe("The Workflow's name."),
          class_name: z.string().min(1).describe("The Workflow class the Worker exports."),
        },
        "the Workflow is one of this Worker's",
      ),
    )
    .describe("Workflows defined by this Worker.")
    .optional(),
  services: z
    .array(
      entrySchema(
        "services",
        {
          binding: bindingNameSchema,
          service: z
            .string()
            .min(1)
            .describe(
              "This Worker, or another Worker of the entry, by the name the packer gives it " +
                "(`install.workerName`, or `<workerName>-<name>`).",
            ),
          entrypoint: z
            .string()
            .min(1)
            .describe("The named entrypoint the binding calls.")
            .optional(),
        },
        "it binds to this Worker or another Worker of the entry, by the name the packer gives it",
      ),
    )
    .describe("Service bindings to this Worker or another Worker of the entry.")
    .optional(),
  ai: soleBinding("ai").describe("The Workers AI binding.").optional(),
  browser: soleBinding("browser").describe("The Browser Rendering binding.").optional(),
  images: soleBinding("images").describe("The Images binding.").optional(),
  version_metadata: soleBinding("version_metadata")
    .describe("The version metadata binding.")
    .optional(),
} satisfies Record<WranglerConfigInlineKey, z.ZodType>;

type InlineConfigShape = z.infer<z.ZodObject<typeof wranglerConfigInlineShape>>;

/** What is wrong across the keys of an inline config; empty when nothing is. */
function wranglerConfigInlineProblems(config: InlineConfigShape): string[] {
  const problems: string[] = [];
  if (config.main === undefined && config.assets === undefined) {
    problems.push("an inline config needs main, assets, or both");
  }
  const classes = new Set<string>();
  for (const migration of config.migrations ?? []) {
    for (const name of migration.new_sqlite_classes ?? []) classes.add(name);
    for (const { from, to } of migration.renamed_classes ?? []) {
      classes.delete(from);
      classes.add(to);
    }
    for (const name of migration.deleted_classes ?? []) classes.delete(name);
  }
  for (const binding of config.durable_objects?.bindings ?? []) {
    if (!classes.has(binding.class_name)) {
      problems.push(
        `the Durable Object binding ${binding.name} names the class ${binding.class_name}, which ` +
          "the inline config's migrations do not create in new_sqlite_classes",
      );
    }
  }
  return problems;
}

/**
 * An inline wrangler config: the keys of {@link WRANGLER_CONFIG_INLINE_KEYS},
 * every other one refused with a reason. `compatibility_date` is required,
 * and `main` or `assets`.
 */
export const wranglerConfigInlineSchema = z
  // Not z.record: it would drop a `__proto__` key, which must be refused.
  .custom<Record<string, unknown>>(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
    { message: "an inline wrangler config is an object" },
  )
  .superRefine((config, ctx) => {
    for (const key of Object.keys(config)) {
      if ((WRANGLER_CONFIG_INLINE_KEYS as readonly string[]).includes(key)) continue;
      const reason = isUnsupportedWranglerSection(key)
        ? "Appflare cannot install it"
        : REFUSED_KEY_REASONS.get(key);
      ctx.addIssue({
        code: "custom",
        path: [key],
        message:
          `an inline wrangler config may not set ${key}${reason === undefined ? "" : `: ${reason}`}; ` +
          `it may set only ${WRANGLER_CONFIG_INLINE_KEYS.join(", ")}`,
      });
    }
  })
  .pipe(
    z.strictObject(wranglerConfigInlineShape).superRefine((config, ctx) => {
      for (const message of wranglerConfigInlineProblems(config)) {
        ctx.addIssue({ code: "custom", message });
      }
    }),
  )
  .describe(
    "The wrangler config of an app whose repository ships none, which the packer writes as " +
      "`.appflare.wrangler.jsonc` where `wranglerConfig` names, with the Worker's `name` added. " +
      `Allowed keys: ${WRANGLER_CONFIG_INLINE_KEYS.join(", ")}. Storage bindings carry no ids, ` +
      "Durable Object and Workflow bindings point at this Worker's classes, and Durable Object " +
      "migrations use new_sqlite_classes. Prefer a pull request upstream that adds the config, " +
      "and link it in a comment beside this one.",
  );
export type WranglerConfigInline = z.infer<typeof wranglerConfigInlineSchema>;

/**
 * Why `wranglerConfig` cannot name where an inline config is written, or
 * null when it can: it must be `.appflare.wrangler.jsonc`, at the root or in
 * a directory relative to it without `..`, so the packer never writes over a
 * file of the repository.
 */
export function inlineConfigPathProblem(wranglerConfig: string): string | null {
  const base = wranglerConfig.split("/").pop();
  const inside = configRelativePathSchema.safeParse(wranglerConfig).success;
  if (base === PATCHED_WRANGLER_CONFIG && inside && !wranglerConfig.includes("\\")) return null;
  return (
    `with an inline wrangler config, wranglerConfig names where the packer writes it: ` +
    `${PATCHED_WRANGLER_CONFIG}, or <directory>/${PATCHED_WRANGLER_CONFIG} for a Worker in a ` +
    `directory of the repository, not "${wranglerConfig}"`
  );
}

/** The config the packer writes for `inline`: the Worker's `name` first, then the rest. */
export function inlineWranglerConfig(
  inline: WranglerConfigInline,
  name: string,
): Record<string, unknown> {
  return { name, ...inline };
}
