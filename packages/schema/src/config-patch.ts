import { z } from "zod";
import {
  isUnsupportedWranglerSection,
  UNSUPPORTED_WRANGLER_SECTIONS,
  type UnsupportedWranglerSection,
} from "./wrangler-sections.ts";

/**
 * A catalog entry's `install.configPatch` (and `install.workers[].configPatch`):
 * a JSON merge patch (RFC 7386) the packer applies to the app's wrangler
 * config before wrangler reads it, for the few changes an app needs to
 * install from its pinned commit when upstream has not taken them yet: an
 * entrypoint or assets directory its build moves, a build step the catalog
 * runs itself, a service binding to a Worker that is not part of the app,
 * storage bindings without ids so they are provisioned, or Durable Object
 * classes that must be SQLite-backed on the Free plan. It may also drop a
 * section the packer refuses (`"vpc_services": null`, see
 * {@link UNSUPPORTED_WRANGLER_SECTIONS}) from an app that works without it.
 *
 * The patch is allowlisted by key, and some keys only in one direction (see
 * {@link configPatchProblems}), so a patch can never point the app at
 * another account's resources or change what the manager provisions beyond
 * what the config itself asks for. It is part of the catalog manifest, so the
 * artifact's signature covers it, and the pack log prints its effect.
 *
 * This module imports nothing but zod and modules that import nothing:
 * `catalog.ts` imports it, and the JSON Schema export runs `catalog.ts`
 * directly under Node's type stripping.
 */

/**
 * The `info().features` entry of a sandbox Worker whose packer applies an
 * entry's config patch. A sandbox Worker without it would build such an
 * entry from the unpatched config.
 */
export const SANDBOX_FEATURE_CONFIG_PATCH = "config-patch";

/** The file the packer writes the patched config to, beside the app's own config. */
export const PATCHED_WRANGLER_CONFIG = ".appflare.wrangler.jsonc";

/** The top-level keys a config patch may set, in the order the pack log shows them. */
export const CONFIG_PATCH_KEYS = [
  "main",
  "assets",
  "build",
  "services",
  "kv_namespaces",
  "r2_buckets",
  "d1_databases",
  "vars",
  "migrations",
  "ratelimits",
] as const;
export type ConfigPatchKey = (typeof CONFIG_PATCH_KEYS)[number];

/** Why a key outside {@link CONFIG_PATCH_KEYS} is refused, for the keys a maintainer might reach for. */
const REFUSED_KEY_REASONS = new Map<string, string>([
  ["__proto__", "it is not a wrangler config key"],
  ["name", "the Worker's name comes from the install, not the config"],
  ["account_id", "the account is the one the app is installed in"],
  [
    "durable_objects",
    "Durable Object bindings carry no storage backend; to make a class SQLite-backed, rename " +
      "new_classes to new_sqlite_classes in migrations",
  ],
  ["env", "the packer builds the config's top level, not an environment"],
  ["routes", "routes belong to the install, not the artifact"],
  ["route", "routes belong to the install, not the artifact"],
  ["compatibility_date", "change it upstream, since the app is tested against it"],
  ["compatibility_flags", "change them upstream, since the app is tested against them"],
]);

const RFC_7386 =
  "a JSON merge patch (RFC 7386): an object merges key by key, null removes a key, and " +
  "anything else, arrays included, replaces the value";

const nullableString = z.string().min(1).nullable();

/**
 * A path relative to the config's directory that stays inside it: not
 * absolute (`/`, `\`, a drive letter) and without a `..` segment, so a
 * patch cannot point the build at files outside the checkout.
 */
const RELATIVE_PATH = /^(?![/\\])(?![A-Za-z]:)(?!(?:.*[/\\])?\.\.(?:[/\\]|$)).+$/;
export const configRelativePathSchema = z
  .string()
  .min(1)
  .regex(
    RELATIVE_PATH,
    "must be a path relative to the wrangler config, not absolute and without ..",
  );

/** `assets` in a patch: the directory, binding and handling a build moves. */
const assetsPatchSchema = z
  .strictObject({
    directory: configRelativePathSchema.nullable().optional(),
    binding: nullableString.optional(),
    html_handling: nullableString.optional(),
    not_found_handling: nullableString.optional(),
    run_worker_first: z
      .union([z.boolean(), z.array(z.string())])
      .nullable()
      .optional(),
  })
  .nullable();

// List entries keep the rest of wrangler's fields as JSON values (a kept
// entry must equal the config's, whatever it holds), typed as JSON rather
// than `unknown` so a parsed manifest stays serialisable.
const jsonValue = z.json();
const bindingNameSchema = z
  .string()
  .min(1)
  .describe("The binding's name, as the Worker reads it from `env`.");

/** One binding of a storage list (`kv_namespaces`, `r2_buckets`, `d1_databases`) in a patch. */
const storageEntrySchema = z.object({ binding: bindingNameSchema }).catchall(jsonValue);

/** One service binding in a patch. */
const serviceEntrySchema = z
  .object({
    binding: bindingNameSchema,
    service: z.string().min(1).describe("The name of the Worker the binding points at."),
  })
  .catchall(jsonValue);

/** One Durable Object migration in a patch. */
const migrationEntrySchema = z
  .object({ tag: z.string().min(1).describe("The migration's tag, as the config gives it.") })
  .catchall(jsonValue);

const configPatchShape = {
  main: configRelativePathSchema
    .describe(
      "The Worker's entrypoint, relative to the config, for example `dist/index.js`; not " +
        "absolute and without `..`.",
    )
    .optional(),
  assets: assetsPatchSchema
    .describe(
      "Merged into the config's `assets`: `directory`, `binding`, `html_handling`, " +
        "`not_found_handling`, `run_worker_first`; null removes a key, or `assets` itself.",
    )
    .optional(),
  build: z
    .null({ error: "build may only be null, which removes the config's build" })
    .describe(
      "Only null: removes the config's `build`, when `install.buildCommand` builds instead.",
    )
    .optional(),
  services: z
    .array(serviceEntrySchema)
    .nullable()
    .describe(
      "The whole list of service bindings (a merge patch replaces arrays): the config's own " +
        "entries, some left out, and entries that point at a Worker of this entry. null " +
        "removes them all.",
    )
    .optional(),
  kv_namespaces: z
    .array(storageEntrySchema)
    .describe(
      "The whole list: every binding of the config, plus new ones. A binding whose `id` is an " +
        "empty string or a placeholder (`$NAME`, `${NAME}`, `{{NAME}}`, `<NAME>`) may leave it " +
        'out, so the install provisions it; "" is refused by wrangler.',
    )
    .optional(),
  r2_buckets: z
    .array(storageEntrySchema)
    .describe(
      "The whole list: every binding of the config, plus new ones. A binding whose " +
        "`bucket_name` is an empty string or a placeholder may leave it out.",
    )
    .optional(),
  d1_databases: z
    .array(storageEntrySchema)
    .describe(
      "The whole list: every binding of the config, plus new ones. A binding whose " +
        "`database_id` is an empty string or a placeholder may leave it out.",
    )
    .optional(),
  vars: z
    .record(z.string(), z.null({ error: "a config patch may only remove vars, with null" }))
    .nullable()
    .describe("Only removals: each var to remove as null, or null to remove them all.")
    .optional(),
  ratelimits: z
    .array(
      z
        .object({
          name: bindingNameSchema,
          namespace_id: z
            .string()
            .min(1)
            .describe("The limit's namespace; the install gives each one of its own."),
          simple: z
            .strictObject({
              limit: z.int().min(1).describe("Requests allowed per period."),
              period: z.union([z.literal(10), z.literal(60)]).describe("Seconds: 10 or 60."),
            })
            .describe("The limit."),
        })
        .describe("One rate limit binding."),
    )
    .describe(
      "The whole list: every rate limit of the config, unchanged, plus new ones, for a limit " +
        "an upstream deploy script adds.",
    )
    .optional(),
  migrations: z
    .array(migrationEntrySchema)
    .describe(
      "The config's Durable Object migrations, the same list with `new_classes` renamed to " +
        "`new_sqlite_classes`, which the Free plan requires.",
    )
    .optional(),
} satisfies Record<ConfigPatchKey, z.ZodType>;

/**
 * `"<section>": null` for each section the packer refuses: the patch drops
 * it, for an app that works without it. Nothing else may be set there.
 */
const droppedSectionsShape = Object.fromEntries(
  UNSUPPORTED_WRANGLER_SECTIONS.map((key) => [
    key,
    z
      .null({
        error: `${key} may only be null, which drops it: Appflare cannot install it`,
      })
      .describe(`Only null: drops \`${key}\`, which Appflare cannot install, from the config.`)
      .optional(),
  ]),
) as Record<UnsupportedWranglerSection, z.ZodOptional<z.ZodNull>>;

/**
 * The shape of a config patch, with every key outside {@link CONFIG_PATCH_KEYS}
 * refused with a reason. What a key may change relative to the config it
 * patches is checked by {@link configPatchProblems} at pack time.
 */
export const configPatchSchema = z
  // Not z.record: it would drop a `__proto__` key, which must be refused.
  .custom<Record<string, unknown>>(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
    { message: "a config patch is an object" },
  )
  // Unknown keys first, each with its reason; the shape of the allowed ones after.
  .superRefine((patch, ctx) => {
    for (const key of Object.keys(patch)) {
      if ((CONFIG_PATCH_KEYS as readonly string[]).includes(key)) continue;
      // Checked by the shape below: only null, which drops the section.
      if (isUnsupportedWranglerSection(key)) continue;
      const reason = REFUSED_KEY_REASONS.get(key);
      ctx.addIssue({
        code: "custom",
        path: [key],
        message:
          `a config patch may not set ${key}${reason === undefined ? "" : `: ${reason}`}; ` +
          `it may set only ${CONFIG_PATCH_KEYS.join(", ")}, or null to drop a section Appflare ` +
          "cannot install",
      });
    }
    if (Object.keys(patch).length === 0) {
      ctx.addIssue({ code: "custom", message: "a config patch changes at least one key" });
    }
  })
  .pipe(z.strictObject({ ...configPatchShape, ...droppedSectionsShape }))
  .meta({ minProperties: 1 })
  .describe(
    `Changes to the app's wrangler config, applied before wrangler reads it, as ${RFC_7386}. ` +
      `Allowed keys: ${CONFIG_PATCH_KEYS.join(", ")}; a section Appflare cannot install ` +
      "(such as `vpc_services`) may be set to null, which drops it, when the app works " +
      "without it. Prefer a pull request upstream and link " +
      "it in a comment beside the patch; the patch is for the time until it is merged.",
  );
export type ConfigPatch = z.infer<typeof configPatchSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether two JSON values are equal, key order aside. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

/** Sets an own property, even one named `__proto__`, without touching the prototype. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * RFC 7386 merge: an object in `patch` merges key by key into `target`, a
 * null removes the key, anything else (arrays included) replaces it. Neither
 * argument is changed.
 */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isRecord(patch)) return structuredClone(patch);
  const result: Record<string, unknown> = {};
  if (isRecord(target)) {
    for (const [key, value] of Object.entries(target)) setOwn(result, key, value);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else {
      setOwn(result, key, applyMergePatch(result[key], value));
    }
  }
  return result;
}

/**
 * A value an upstream config holds in place of a storage id for its own
 * deploy script to fill: `$NAME`, `${NAME}`, `{{NAME}}` or `<NAME>` (a name
 * of letters, digits, `_`, `-` and `.`, spaces allowed inside the braces).
 */
const ID_PLACEHOLDER =
  /^(?:\$[A-Za-z_][\w]*|\$\{[A-Za-z_][\w.-]*\}|\{\{\s*[A-Za-z_][\w.-]*\s*\}\}|<[A-Za-z_][\w.-]*>)$/;

/** Whether a storage id is one a patch may clear: empty, or a placeholder. */
export function isClearableStorageId(id: unknown): boolean {
  return id === "" || (typeof id === "string" && ID_PLACEHOLDER.test(id));
}

/** The key each storage list's id lives under, which a patch may clear (see {@link isClearableStorageId}). */
const STORAGE_ID_KEYS = {
  kv_namespaces: "id",
  r2_buckets: "bucket_name",
  d1_databases: "database_id",
} as const;

function bindingName(entry: unknown): string | null {
  return isRecord(entry) && typeof entry.binding === "string" ? entry.binding : null;
}

/** Bindings named twice in `entries`. */
function duplicateBindings(entries: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const entry of entries) {
    const name = bindingName(entry);
    if (name === null) continue;
    if (seen.has(name)) twice.add(name);
    seen.add(name);
  }
  return [...twice];
}

function storageProblems(
  key: keyof typeof STORAGE_ID_KEYS,
  original: unknown,
  patched: readonly unknown[],
): string[] {
  const idKey = STORAGE_ID_KEYS[key];
  const before = Array.isArray(original) ? original : [];
  const problems = duplicateBindings(patched).map(
    (name) => `${key} names the binding ${name} twice`,
  );
  const after = new Map<string, Record<string, unknown>>();
  for (const entry of patched) {
    const name = bindingName(entry);
    if (name !== null && isRecord(entry)) after.set(name, entry);
  }
  for (const entry of before) {
    const name = bindingName(entry);
    if (name === null || !isRecord(entry)) continue;
    const next = after.get(name);
    if (next === undefined) {
      problems.push(
        `${key} leaves out the binding ${name}; a patch may only add storage bindings, never remove one`,
      );
      continue;
    }
    if (jsonEqual(entry, next)) continue;
    const { [idKey]: id, ...rest } = entry;
    if (isClearableStorageId(id) && !Object.hasOwn(next, idKey) && jsonEqual(rest, next)) continue;
    problems.push(
      `${key} changes the binding ${name}; a patch may only add storage bindings, or leave out ` +
        `a "${idKey}" that is empty or a placeholder so the install provisions it`,
    );
  }
  return problems;
}

/** A rate limit's name: its binding. */
function rateLimitName(entry: unknown): string | null {
  return isRecord(entry) && typeof entry.name === "string" ? entry.name : null;
}

/**
 * What a patch of `ratelimits` changes that it may not: it may only add
 * rate limits, keeping every one of the config's as it is.
 */
function rateLimitProblems(original: unknown, patched: readonly unknown[]): string[] {
  const before = Array.isArray(original) ? original : [];
  const names = patched.map(rateLimitName).filter((n): n is string => n !== null);
  const problems = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))].map(
    (name) => `ratelimits names the binding ${name} twice`,
  );
  for (const entry of before) {
    const name = rateLimitName(entry) ?? "(unnamed)";
    const next = patched.find((p) => rateLimitName(p) === rateLimitName(entry));
    if (next === undefined) {
      problems.push(
        `ratelimits leaves out the binding ${name}; a patch may only add rate limits, never remove one`,
      );
    } else if (!jsonEqual(entry, next)) {
      problems.push(
        `ratelimits changes the binding ${name}; a patch may only add rate limits, keeping the config's as they are`,
      );
    }
  }
  return problems;
}

function servicesProblems(
  original: unknown,
  patched: readonly unknown[],
  entryWorkers: ReadonlySet<string>,
): string[] {
  const before = Array.isArray(original) ? original : [];
  const problems = duplicateBindings(patched).map(
    (name) => `services names the binding ${name} twice`,
  );
  for (const entry of patched) {
    if (before.some((kept) => jsonEqual(kept, entry))) continue;
    const service = isRecord(entry) && typeof entry.service === "string" ? entry.service : null;
    if (service !== null && entryWorkers.has(service)) continue;
    problems.push(
      `services adds or changes the binding ${bindingName(entry) ?? "(unnamed)"}; a patch may ` +
        "only leave service bindings out, or add one to a Worker of this entry " +
        `(${[...entryWorkers].join(", ") || "none"})`,
    );
  }
  return problems;
}

/** `migration` with its `new_classes` moved to the end of `new_sqlite_classes`. */
function sqliteMigration(migration: Record<string, unknown>): Record<string, unknown> {
  const { new_classes: kv, ...rest } = migration;
  if (!Array.isArray(kv)) return migration;
  const sqlite = Array.isArray(rest.new_sqlite_classes) ? rest.new_sqlite_classes : [];
  return { ...rest, new_sqlite_classes: [...sqlite, ...kv] };
}

function migrationsProblems(original: unknown, patched: readonly unknown[]): string[] {
  const before = Array.isArray(original) ? original : [];
  const refusal =
    "a patch may only rename new_classes to new_sqlite_classes in the config's own migrations";
  if (before.length !== patched.length) {
    return [
      `migrations has ${patched.length} migrations where the config has ${before.length}; ${refusal}`,
    ];
  }
  const problems: string[] = [];
  before.forEach((migration, i) => {
    const next = patched[i];
    if (jsonEqual(migration, next)) return;
    if (isRecord(migration) && jsonEqual(sqliteMigration(migration), next)) return;
    const tag = isRecord(migration) && typeof migration.tag === "string" ? migration.tag : i;
    problems.push(`migrations changes the migration ${tag} otherwise; ${refusal}`);
  });
  return problems;
}

/**
 * What a patch changes that it may not, relative to the raw config it
 * patches (top level, as the file holds it); empty when it may be applied.
 * `entryWorkers` holds the wrangler names of the entry's Workers, this one
 * included: the only Workers a patch may add a service binding to. The
 * shape was checked by {@link configPatchSchema}.
 */
export function configPatchProblems(
  raw: Readonly<Record<string, unknown>>,
  patch: ConfigPatch,
  entryWorkers: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  if (patch.services)
    problems.push(...servicesProblems(raw.services, patch.services, entryWorkers));
  for (const key of Object.keys(STORAGE_ID_KEYS) as Array<keyof typeof STORAGE_ID_KEYS>) {
    const list = patch[key];
    if (list !== undefined) problems.push(...storageProblems(key, raw[key], list));
  }
  if (patch.ratelimits !== undefined) {
    problems.push(...rateLimitProblems(raw.ratelimits, patch.ratelimits));
  }
  if (patch.migrations !== undefined) {
    problems.push(...migrationsProblems(raw.migrations, patch.migrations));
  }
  return problems;
}

/**
 * The effect of a patch, one line per changed path, for the pack log:
 * `main: "src/index.ts" -> "dist/index.js"`, `build: removed`,
 * `vars.DEBUG: removed`. Objects are compared key by key; arrays whole. Values
 * a patch removes are not printed.
 */
export function configPatchDiff(before: unknown, after: unknown, at = ""): string[] {
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) =>
      configPatchDiff(before[key], after[key], at === "" ? key : `${at}.${key}`),
    );
  }
  if (jsonEqual(before, after)) return [];
  if (after === undefined) return [`${at}: removed`];
  if (before === undefined) return [`${at}: added ${JSON.stringify(after)}`];
  return [`${at}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`];
}

/**
 * The raw config with `patch` applied, and the lines of its effect; throws
 * with every problem when the patch changes what it may not.
 */
export function patchWranglerConfig(
  raw: Readonly<Record<string, unknown>>,
  patch: ConfigPatch,
  entryWorkers: ReadonlySet<string>,
): { config: Record<string, unknown>; diff: string[] } {
  const problems = configPatchProblems(raw, patch, entryWorkers);
  if (problems.length > 0) {
    throw new Error(`the config patch cannot be applied: ${problems.join("; ")}`);
  }
  const config = applyMergePatch(raw, patch) as Record<string, unknown>;
  const touched = Object.keys(patch);
  const pick = (from: Record<string, unknown>) =>
    Object.fromEntries(touched.filter((k) => Object.hasOwn(from, k)).map((k) => [k, from[k]]));
  return { config, diff: configPatchDiff(pick(raw), pick(config)) };
}
