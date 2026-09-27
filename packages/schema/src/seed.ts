import { z } from "zod";
import {
  MAX_SEED_PARAMS,
  MAX_SEED_SQL_LENGTH,
  MAX_SEED_STATEMENTS,
  seedStatementProblems,
} from "./sql-guard.ts";

/**
 * Seed statements: the rows an app needs before anyone can sign in to it
 * (its first admin account), added once, at install, from values the admin
 * enters in the install form. A catalog manifest declares them per D1
 * binding as `resources.d1[binding].seed`:
 *
 * - `hashes` names values derived from secrets, such as a password hash in
 *   the exact form the app checks it (PBKDF2-SHA-256 with its parameters, or
 *   bcrypt); each is computed once per run, so a hash and its salt match;
 * - `statements` are single `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`
 *   statements with anonymous `?` placeholders, one param per placeholder
 *   (see `seedStatementProblems`). A param is an object, never text spliced
 *   into the SQL: `{ var }`, `{ secret }`, `{ hash }`, `{ salt }` or
 *   `{ value }`;
 * - `beforeSchema: true` runs them before the binding's schema files instead
 *   of after, so a seed can claim a row a schema file would otherwise fill
 *   with a default.
 *
 * Secrets and vars marked `seedOnly` exist only for seeds: the install form
 * asks for them once, and they are never bound to the Worker nor stored.
 *
 * WebCrypto only (`crypto.subtle`, `crypto.getRandomValues`), so the manager
 * Worker, catalog CI and the browser share it.
 */

/**
 * The `info().features` entry of a sandbox Worker whose builds keep an
 * entry's seed statements. One without it hands its packer the catalog
 * manifest without them, and the build it returns would not match the
 * entry, so the manager refuses to send such an entry to it.
 */
export const SANDBOX_FEATURE_D1_SEED = "d1-seed";

/** The most PBKDF2 iterations workerd's WebCrypto derives (`checkPbkdfLimits`); it refuses more. */
export const PBKDF2_MAX_ITERATIONS = 100_000;
/** The fewest PBKDF2 iterations a seed hash may ask for. */
export const PBKDF2_MIN_ITERATIONS = 1_000;
/** Salt and key sizes a PBKDF2 seed hash may ask for, in bytes. */
export const PBKDF2_MIN_BYTES = 16;
export const PBKDF2_MAX_BYTES = 64;
/** How a PBKDF2 seed hash's hash and salt are written into the row. */
export const SEED_HASH_ENCODINGS = ["base64url", "base64", "hex"] as const;
export type SeedHashEncoding = (typeof SEED_HASH_ENCODINGS)[number];

/** The bcrypt cost of a seed hash that names none. */
export const SEED_BCRYPT_DEFAULT_COST = 10;
/** Bcrypt costs a seed hash may ask for: at most the cost measured within Workers Free's CPU limit. */
export const SEED_BCRYPT_MIN_COST = 4;
export const SEED_BCRYPT_MAX_COST = 10;
/** bcrypt reads only the first 72 bytes of its input; a longer value is refused rather than cut. */
export const BCRYPT_MAX_INPUT_BYTES = 72;

/** Most hashes one binding's seed derives. */
export const MAX_SEED_HASHES = 4;
/** Longest literal `{ value }` param, in characters. */
export const MAX_SEED_VALUE_LENGTH = 1024;

/** The name of a seed hash, as `{ hash }` and `{ salt }` params refer to it. */
export const seedHashIdSchema = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/,
    "must be a letter, then up to 63 letters, digits, _ or -",
  );

const secretNameRef = z.string().min(1).max(128);

/** A PBKDF2-SHA-256 hash of a secret, with a fresh random salt. */
export const seedPbkdf2HashSchema = z
  .strictObject({
    from: secretNameRef.describe(
      "The secret whose value is hashed: a secret of this manifest, neither optional nor derived.",
    ),
    method: z.literal("pbkdf2-sha256"),
    iterations: z
      .int()
      .min(PBKDF2_MIN_ITERATIONS)
      .max(PBKDF2_MAX_ITERATIONS)
      .describe(
        `PBKDF2 iterations, as the app checks them. At most ${PBKDF2_MAX_ITERATIONS}: Cloudflare Workers refuse to derive more.`,
      ),
    saltBytes: z
      .int()
      .min(PBKDF2_MIN_BYTES)
      .max(PBKDF2_MAX_BYTES)
      .describe("Bytes of random salt; `{ salt }` params write it with `encoding`."),
    keyBytes: z
      .int()
      .min(PBKDF2_MIN_BYTES)
      .max(PBKDF2_MAX_BYTES)
      .describe("Bytes of derived key; `{ hash }` params write it with `encoding`."),
    encoding: z
      .enum(SEED_HASH_ENCODINGS)
      .describe(
        "How the hash and salt are written: `base64url` (unpadded), `base64` (padded) or `hex` (lower case).",
      ),
  })
  .describe("A PBKDF2-SHA-256 hash of a secret with a fresh random salt, as the app stores it.");
export type SeedPbkdf2Hash = z.infer<typeof seedPbkdf2HashSchema>;

/** A bcrypt hash of a secret (`$2b$`), whose salt is part of the hash. */
export const seedBcryptHashSchema = z
  .strictObject({
    from: secretNameRef.describe(
      "The secret whose value is hashed: a secret of this manifest, neither optional nor derived. " +
        `Values longer than ${BCRYPT_MAX_INPUT_BYTES} bytes are refused at install.`,
    ),
    method: z.literal("bcrypt"),
    cost: z
      .int()
      .min(SEED_BCRYPT_MIN_COST)
      .max(SEED_BCRYPT_MAX_COST)
      .describe(`The bcrypt cost (log2 of the rounds); ${SEED_BCRYPT_DEFAULT_COST} when omitted.`)
      .optional(),
  })
  .describe("A bcrypt hash (`$2b$`) of a secret; its salt is part of the hash.");
export type SeedBcryptHash = z.infer<typeof seedBcryptHashSchema>;

export const seedHashSchema = z.discriminatedUnion("method", [
  seedPbkdf2HashSchema,
  seedBcryptHashSchema,
]);
export type SeedHash = z.infer<typeof seedHashSchema>;

/** The bcrypt cost a seed hash runs at. */
export function seedBcryptCost(hash: SeedBcryptHash): number {
  return hash.cost ?? SEED_BCRYPT_DEFAULT_COST;
}

/**
 * One bound value of a seed statement. Exactly one key: `var` (a var of this
 * manifest), `secret` (a secret of this manifest), `hash` or `salt` (a hash
 * of the seed's `hashes`), or `value` (literal text).
 */
export const seedParamSchema = z.union([
  z.strictObject({ var: z.string().min(1).max(128).describe("A var of this manifest.") }),
  z.strictObject({ secret: secretNameRef.describe("A secret of this manifest, not optional.") }),
  z.strictObject({ hash: seedHashIdSchema.describe("A hash of this seed's `hashes`.") }),
  z.strictObject({
    salt: seedHashIdSchema.describe("The salt of a `pbkdf2-sha256` hash of this seed's `hashes`."),
  }),
  z.strictObject({
    value: z.string().max(MAX_SEED_VALUE_LENGTH).describe("Literal text, bound as it is."),
  }),
]);
export type SeedParam = z.infer<typeof seedParamSchema>;

/** One seed statement: one guarded INSERT and its params, in placeholder order. */
export const seedStatementSchema = z
  .strictObject({
    sql: z
      .string()
      .min(1)
      .max(MAX_SEED_SQL_LENGTH)
      .describe(
        "Exactly one `INSERT OR IGNORE` or `INSERT ... ON CONFLICT ... DO NOTHING` statement, with an " +
          "anonymous `?` placeholder for each param. No `WITH`, `DO UPDATE`, other statement kinds, " +
          "numbered or named parameters, and no `d1_migrations`, `sqlite_` or `_cf_` tables.",
      ),
    params: z
      .array(seedParamSchema)
      .max(MAX_SEED_PARAMS)
      .describe("The values bound to the placeholders, in order: one object per `?`."),
  })
  .superRefine((statement, ctx) => {
    for (const problem of seedStatementProblems(statement.sql, statement.params.length)) {
      ctx.addIssue({ code: "custom", path: ["sql"], message: problem });
    }
  });
export type SeedStatement = z.infer<typeof seedStatementSchema>;

/** Where a problem of a seed sits, below the seed, and what it is. */
export interface SeedProblem {
  path: Array<string | number>;
  message: string;
}

/**
 * What is wrong with the hashes a seed's params name, one issue each: every
 * `{ hash }` and `{ salt }` names a declared hash, `{ salt }` only a PBKDF2
 * one (bcrypt keeps its salt in the hash), and every hash is used.
 */
export function seedHashRefProblems(seed: {
  hashes?: Readonly<Record<string, SeedHash>> | undefined;
  statements: ReadonlyArray<{ params: readonly SeedParam[] }>;
}): SeedProblem[] {
  const hashes = seed.hashes ?? {};
  const hashOf = (id: string) => (Object.hasOwn(hashes, id) ? hashes[id] : undefined);
  const used = new Set<string>();
  const problems: SeedProblem[] = [];
  seed.statements.forEach((statement, i) => {
    statement.params.forEach((param, j) => {
      const path = ["statements", i, "params", j];
      if ("hash" in param) {
        used.add(param.hash);
        if (hashOf(param.hash) === undefined) {
          problems.push({
            path,
            message: `the hash "${param.hash}" is not one of this seed's hashes`,
          });
        }
      } else if ("salt" in param) {
        used.add(param.salt);
        const hash = hashOf(param.salt);
        if (hash === undefined) {
          problems.push({
            path,
            message: `the hash "${param.salt}" is not one of this seed's hashes`,
          });
        } else if (hash.method !== "pbkdf2-sha256") {
          problems.push({
            path,
            message: `the hash "${param.salt}" is ${hash.method}, whose salt is part of the hash; only a pbkdf2-sha256 hash has a salt of its own`,
          });
        }
      }
    });
  });
  for (const id of Object.keys(hashes)) {
    if (!used.has(id)) {
      problems.push({
        path: ["hashes", id],
        message: `the hash "${id}" is never used by a statement`,
      });
    }
  }
  return problems;
}

/** Rows one D1 binding gets once, at install; see the top of this file. */
export const catalogD1SeedSchema = z
  .strictObject({
    hashes: z
      .record(seedHashIdSchema, seedHashSchema)
      .describe(
        "Values derived from secrets, by name, for `{ hash }` and `{ salt }` params: a " +
          "`pbkdf2-sha256` hash with explicit parameters, or a `bcrypt` hash. Each is computed once " +
          "per install, so a hash and its salt match. Never logged or stored by Appflare.",
      )
      .optional(),
    statements: z
      .array(seedStatementSchema)
      .min(1)
      .max(MAX_SEED_STATEMENTS)
      .describe(
        "The statements, run in order, each once, at install only. Updates never run them, even when " +
          "they change.",
      ),
    beforeSchema: z
      .boolean()
      .describe(
        "Run the statements before the binding's schema files instead of after them (the default), " +
          "so a seeded row wins over a default row a schema file adds with INSERT OR IGNORE. " +
          "The binding's migrations always run first; post-deploy migrations run after the seed " +
          "when `beforeSchema` is set.",
      )
      .optional(),
  })
  .superRefine((seed, ctx) => {
    if (Object.keys(seed.hashes ?? {}).length > MAX_SEED_HASHES) {
      ctx.addIssue({
        code: "custom",
        path: ["hashes"],
        message: `a seed derives at most ${MAX_SEED_HASHES} hashes`,
      });
    }
    for (const problem of seedHashRefProblems(seed)) {
      ctx.addIssue({ code: "custom", path: problem.path, message: problem.message });
    }
  })
  .describe(
    "Rows the app needs before anyone can sign in (a first admin account), added once at install " +
      "with values from the install form, bound as D1 parameters. Not allowed on self-deploying " +
      "entries.",
  );
export type CatalogD1Seed = z.infer<typeof catalogD1SeedSchema>;

/** What the seed checks read of a secret. */
export interface SeedSecretFacts {
  name: string;
  optional?: boolean | undefined;
  derive?: { from: string } | undefined;
  seedOnly?: boolean | undefined;
  workers?: readonly string[] | undefined;
}

/** What the seed checks read of a var. */
export interface SeedVarFacts {
  name: string;
  required: boolean;
  default?: string | undefined;
  derive?: { from: string } | undefined;
  seedOnly?: boolean | undefined;
  workers?: readonly string[] | undefined;
}

/** Whether a secret or var exists only for seeds (`seedOnly: true`). */
export function isSeedOnly(item: { seedOnly?: boolean | undefined }): boolean {
  return item.seedOnly === true;
}

/** The secrets or vars the Worker gets: every one but the seed-only ones. */
export function boundToWorker<T extends { seedOnly?: boolean | undefined }>(
  items: readonly T[],
): T[] {
  return items.filter((item) => !isSeedOnly(item));
}

/** Every D1 seed of a manifest, by binding. */
export function manifestSeeds(resources: {
  d1?: Readonly<Record<string, { seed?: CatalogD1Seed | undefined }>> | undefined;
}): Array<[binding: string, seed: CatalogD1Seed]> {
  return Object.entries(resources.d1 ?? {}).flatMap(([binding, d1]) =>
    d1.seed === undefined ? [] : [[binding, d1.seed] as [string, CatalogD1Seed]],
  );
}

/**
 * What is wrong with how a manifest's seeds and its secrets and vars fit
 * together, one issue each with its path from the manifest's root:
 *
 * - a `{ var }` names a declared var that always has a value (required, with
 *   a default, or derived); a `{ secret }` a declared secret that is not
 *   optional; a hash's `from` a declared secret neither optional nor derived;
 * - a seed-only secret or var is used by a seed, is not optional, derived or
 *   limited to some Workers, and nothing is derived from it (it is not kept,
 *   so nothing could be computed from it later).
 */
export function seedManifestProblems(manifest: {
  secrets: readonly SeedSecretFacts[];
  vars: readonly SeedVarFacts[];
  resources?:
    | { d1?: Readonly<Record<string, { seed?: CatalogD1Seed | undefined }>> | undefined }
    | undefined;
}): SeedProblem[] {
  const problems: SeedProblem[] = [];
  const secrets = new Map(manifest.secrets.map((s) => [s.name, s]));
  const vars = new Map(manifest.vars.map((v) => [v.name, v]));
  const usedSecrets = new Set<string>();
  const usedVars = new Set<string>();
  for (const [binding, seed] of manifestSeeds(manifest.resources ?? {})) {
    const at = ["resources", "d1", binding, "seed"];
    for (const [id, hash] of Object.entries(seed.hashes ?? {})) {
      usedSecrets.add(hash.from);
      const source = secrets.get(hash.from);
      const path = [...at, "hashes", id, "from"];
      if (source === undefined) {
        problems.push({
          path,
          message: `the hash "${id}" is of ${hash.from}, which is not a secret of this manifest`,
        });
      } else if (source.optional === true) {
        problems.push({
          path,
          message: `the hash "${id}" is of ${hash.from}, which is optional; hash a secret every install has`,
        });
      } else if (source.derive !== undefined) {
        problems.push({
          path,
          message: `the hash "${id}" is of ${hash.from}, which is itself derived; hash the secret the admin enters`,
        });
      }
    }
    seed.statements.forEach((statement, i) => {
      statement.params.forEach((param, j) => {
        const path = [...at, "statements", i, "params", j];
        if ("var" in param) {
          usedVars.add(param.var);
          const v = vars.get(param.var);
          if (v === undefined) {
            problems.push({ path, message: `${param.var} is not a var of this manifest` });
          } else if (!v.required && v.default === undefined && v.derive === undefined) {
            problems.push({
              path,
              message: `${param.var} may be left empty; a var a seed uses must be required, have a default, or be derived`,
            });
          }
        } else if ("secret" in param) {
          usedSecrets.add(param.secret);
          const s = secrets.get(param.secret);
          if (s === undefined) {
            problems.push({ path, message: `${param.secret} is not a secret of this manifest` });
          } else if (s.optional === true) {
            problems.push({
              path,
              message: `${param.secret} is optional; a seed uses secrets every install has`,
            });
          }
        }
      });
    });
  }
  const seedOnlyRules = (
    field: "secrets" | "vars",
    items: ReadonlyArray<SeedSecretFacts | SeedVarFacts>,
    used: ReadonlySet<string>,
  ) => {
    items.forEach((item, i) => {
      if (!isSeedOnly(item)) return;
      const path = [field, i, "seedOnly"];
      if (!used.has(item.name)) {
        problems.push({
          path,
          message: `${item.name} is seed-only, but no seed statement or hash uses it; a seed-only value is asked for only to seed the database`,
        });
      }
      if ("optional" in item && item.optional === true) {
        problems.push({ path, message: `${item.name} is seed-only; it cannot also be optional` });
      }
      if (item.derive !== undefined) {
        problems.push({ path, message: `${item.name} is seed-only; it cannot also be derived` });
      }
      if (item.workers !== undefined) {
        problems.push({
          path,
          message: `${item.name} is seed-only, so no Worker gets it; it cannot name workers`,
        });
      }
    });
  };
  seedOnlyRules("secrets", manifest.secrets, usedSecrets);
  seedOnlyRules("vars", manifest.vars, usedVars);
  const derivedFrom = (
    field: "secrets" | "vars",
    items: ReadonlyArray<SeedSecretFacts | SeedVarFacts>,
  ) => {
    items.forEach((item, i) => {
      const from = item.derive?.from;
      if (from !== undefined && secrets.get(from)?.seedOnly === true) {
        problems.push({
          path: [field, i, "derive", "from"],
          message: `${item.name} derives from ${from}, which is seed-only and never kept; derive from a secret the Worker gets`,
        });
      }
    });
  };
  derivedFrom("secrets", manifest.secrets);
  derivedFrom("vars", manifest.vars);
  return problems;
}

/** One run's derived values of a seed's hashes, by hash id. */
export type SeedHashValues = Record<string, { hash: string; salt?: string }>;

/** The values a seed's params read, by name. */
export interface SeedInputs {
  vars: Readonly<Record<string, string>>;
  secrets: Readonly<Record<string, string>>;
  hashes: Readonly<SeedHashValues>;
}

/**
 * The values bound to one statement, in placeholder order. Throws, naming
 * the param but never a value, when one has no value.
 */
export function seedStatementParams(statement: SeedStatement, inputs: SeedInputs): string[] {
  const of = (record: Readonly<Record<string, string>>, name: string) =>
    Object.hasOwn(record, name) ? record[name] : undefined;
  return statement.params.map((param) => {
    let value: string | undefined;
    let what: string;
    if ("var" in param) {
      value = of(inputs.vars, param.var);
      what = `the var ${param.var}`;
    } else if ("secret" in param) {
      value = of(inputs.secrets, param.secret);
      what = `the secret ${param.secret}`;
    } else if ("hash" in param) {
      value = Object.hasOwn(inputs.hashes, param.hash)
        ? inputs.hashes[param.hash]?.hash
        : undefined;
      what = `the hash "${param.hash}"`;
    } else if ("salt" in param) {
      value = Object.hasOwn(inputs.hashes, param.salt)
        ? inputs.hashes[param.salt]?.salt
        : undefined;
      what = `the salt of "${param.salt}"`;
    } else {
      value = param.value;
      what = "a literal value";
    }
    if (value === undefined) throw new Error(`the seed has no value for ${what}`);
    return value;
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** `bytes` in a seed hash's encoding. */
export function encodeSeedBytes(bytes: Uint8Array, encoding: SeedHashEncoding): string {
  switch (encoding) {
    case "hex":
      return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    case "base64":
      return toBase64(bytes);
    case "base64url":
      return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
}

/**
 * The PBKDF2-SHA-256 hash of `value` with `hash`'s parameters: WebCrypto's
 * `deriveBits` over the UTF-8 bytes of `value` and the raw bytes of `salt`
 * (fresh random bytes when omitted), both written in `hash.encoding`.
 */
export async function pbkdf2SeedHash(
  hash: SeedPbkdf2Hash,
  value: string,
  salt: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(hash.saltBytes)),
): Promise<{ hash: string; salt: string }> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(value),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: hash.iterations },
    key,
    hash.keyBytes * 8,
  );
  return {
    hash: encodeSeedBytes(new Uint8Array(bits), hash.encoding),
    salt: encodeSeedBytes(salt, hash.encoding),
  };
}

/**
 * The secrets a bcrypt seed hash reads, by name: bcrypt reads only the
 * first {@link BCRYPT_MAX_INPUT_BYTES} bytes, so a longer value is refused
 * rather than cut without a word.
 */
export function bcryptSeedSources(resources: {
  d1?: Readonly<Record<string, { seed?: CatalogD1Seed | undefined }>> | undefined;
}): string[] {
  return [
    ...new Set(
      manifestSeeds(resources).flatMap(([, seed]) =>
        Object.values(seed.hashes ?? {}).flatMap((h) => (h.method === "bcrypt" ? [h.from] : [])),
      ),
    ),
  ];
}

/** Why `value` cannot be hashed with bcrypt, or null when it can. Never repeats the value. */
export function bcryptInputProblem(label: string, value: string): string | null {
  const bytes = new TextEncoder().encode(value).length;
  return bytes > BCRYPT_MAX_INPUT_BYTES
    ? `${label} is ${bytes} bytes long; bcrypt reads at most ${BCRYPT_MAX_INPUT_BYTES}, so enter a shorter value.`
    : null;
}
