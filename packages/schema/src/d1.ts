import { z } from "zod";
import { catalogD1SeedSchema } from "./seed.ts";

/**
 * Where an app keeps its D1 SQL when wrangler's migrations folder does not
 * describe it: the catalog manifest's `resources.d1`, keyed by the D1
 * binding's name. Every path is relative to the checkout's root (as
 * `install.wranglerConfig` is), `/`-separated, and stays inside it.
 *
 * - `migrationsDir` replaces the wrangler config's `migrations_dir`: its
 *   `.sql` files are the tracked migrations.
 * - `migrations` is a glob instead of a folder, for tools that write one
 *   folder per migration (Prisma: `prisma/migrations/*\/migration.sql`), as
 *   wrangler's `migrations_dir` plus `migrations_pattern` would say it: the
 *   folder is the glob's segments before its first `*`
 *   ({@link migrationsGlobBase}), and each file is named by its path from
 *   there (`20240101_init/migration.sql`), so a database migrated by wrangler
 *   and one migrated by Appflare record the same names.
 *
 * Migrations run in wrangler's order ({@link compareMigrationNames}).
 * - `schema` lists SQL files that run, in this order, on every install and
 *   update after the migrations, and are never recorded in `d1_migrations`.
 *   Each must be safe to run again: every CREATE TABLE, INDEX, TRIGGER and
 *   VIEW says IF NOT EXISTS, and nothing is dropped or altered.
 * - `postDeployMigrationsDir` holds migrations that run only once the new
 *   version serves all traffic (cleanups the previous code still depends
 *   on), tracked in `d1_migrations` like the others.
 * - `seed` holds statements that run once, at install only, with values
 *   from the install form bound as parameters (see `seed.ts`).
 *
 * The catalog decides these because they are part of the build: a revision
 * cannot change `resources`, so a released version always runs the SQL it
 * was built with.
 */

const SEGMENT = "[0-9A-Za-z.@+_-]+";

/**
 * A path inside the checkout: relative, `/`-separated, of letters, digits and
 * `. @ + _ -`, with no `.` or `..` segment.
 */
export const checkoutRelativePathSchema = z
  .string()
  .max(256)
  .regex(
    new RegExp(`^(?!(?:.*/)?\\.{1,2}(?:/|$))${SEGMENT}(?:/${SEGMENT})*$`),
    "must be a relative path inside the checkout: letters, digits and . @ + _ - separated by /, with no . or .. segment",
  );

/** Why a migrations glob is not one the packer expands, or null when it is. */
export function migrationsGlobProblem(glob: string): string | null {
  const segments = glob.split("/");
  if (
    glob.length === 0 ||
    glob.length > 256 ||
    segments.some((s) => !/^[0-9A-Za-z.@+_*-]+$/.test(s) || s === "." || s === "..")
  ) {
    return "must be a relative path inside the checkout: letters, digits, * and . @ + _ - separated by /, with no . or .. segment";
  }
  if (!segments.some((s) => s.includes("*"))) {
    return "must have a path segment with a * (for example prisma/migrations/*/migration.sql)";
  }
  if (segments[0]?.includes("*")) {
    return "must start with the folder that holds the migrations, before any * (for example prisma/migrations/*/migration.sql), so the packer never searches the whole checkout";
  }
  if (!segments[segments.length - 1]?.endsWith(".sql")) {
    return "must match .sql files (its last segment ends in .sql)";
  }
  return null;
}

/**
 * The folder a migrations glob is relative to, as wrangler's `migrations_dir`
 * is to its `migrations_pattern`: the segments before the first one with a
 * `*` (`prisma/migrations` for `prisma/migrations/*\/migration.sql`), or `.`.
 */
export function migrationsGlobBase(glob: string): string {
  const segments = glob.split("/");
  const wild = segments.findIndex((s) => s.includes("*"));
  const base = segments.slice(0, wild === -1 ? segments.length : wild).join("/");
  return base === "" ? "." : base;
}

/** The first segment of a migration's path read as a number, as wrangler reads it. */
function leadingMigrationNumber(segment: string): number {
  return Number.parseInt(segment.split("_")[0] ?? "", 10);
}

/**
 * The order D1 migrations run in, exactly as wrangler 4.136.2 sorts them
 * (`compareMigrationPaths` in `workers-utils/src/d1-migrations.ts`): segment
 * by segment, a segment's leading number (up to the first `_`) first, so
 * `9_b.sql` runs before `10_a.sql`, then by the segment's text; a path that is
 * a prefix of another runs first.
 */
export function compareMigrationNames(a: string, b: string): number {
  const as = a.split("/");
  const bs = b.split("/");
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const x = as[i] as string;
    const y = bs[i] as string;
    const xn = leadingMigrationNumber(x);
    const yn = leadingMigrationNumber(y);
    if (xn !== yn && !(Number.isNaN(xn) && Number.isNaN(yn))) {
      if (Number.isFinite(xn) && Number.isFinite(yn)) return xn - yn;
      if (Number.isFinite(xn)) return -1;
      if (Number.isFinite(yn)) return 1;
    }
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return as.length - bs.length;
}

/** A glob of migration files: a segment has a `*`, and the files end in `.sql`. */
export const migrationsGlobSchema = z
  .string()
  .regex(/^[0-9A-Za-z.@+_*/-]+$/)
  .superRefine((glob, ctx) => {
    const problem = migrationsGlobProblem(glob);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });

/** How one D1 binding's SQL is laid out, when wrangler's migrations folder does not say. */
export const catalogD1Schema = z
  .object({
    migrationsDir: checkoutRelativePathSchema
      .describe(
        "The folder of the binding's migrations, relative to the checkout's root. Replaces the " +
          "wrangler config's `migrations_dir`: its `.sql` files run and are recorded in " +
          "`d1_migrations` as `wrangler d1 migrations apply` does.",
      )
      .optional(),
    migrations: migrationsGlobSchema
      .describe(
        "A glob of the binding's migration files, relative to the checkout's root, for tools that " +
          "write one folder per migration: `prisma/migrations/*/migration.sql`. The folder before " +
          "the first `*` segment works as wrangler's `migrations_dir` and the glob as its " +
          "`migrations_pattern`: each file is recorded by its path from that folder " +
          "(`20240101_init/migration.sql`), as wrangler records it. Prefer `migrations_pattern` " +
          "in the wrangler config when upstream sets it.",
      )
      .optional(),
    schema: z
      .array(checkoutRelativePathSchema)
      .min(1)
      .describe(
        "SQL files that run on every install and update, in this order, after the migrations, and " +
          "are not recorded in `d1_migrations`. Each must be safe to run again: every CREATE TABLE, " +
          "INDEX, TRIGGER and VIEW says IF NOT EXISTS, and no statement drops or alters anything.",
      )
      .optional(),
    postDeployMigrationsDir: checkoutRelativePathSchema
      .describe(
        "A folder of migrations that run once the new version serves all traffic, for changes the " +
          "previous version's code would break on. Recorded in `d1_migrations` like the others, so " +
          "their file names must differ from the migrations'. Rolling back does not undo them.",
      )
      .optional(),
    seed: catalogD1SeedSchema.optional(),
  })
  .superRefine((d1, ctx) => {
    if (d1.migrationsDir !== undefined && d1.migrations !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["migrations"],
        message: "give the migrations as migrationsDir or as a migrations glob, not both",
      });
    }
    const seen = new Set<string>();
    (d1.schema ?? []).forEach((file, i) => {
      if (seen.has(file)) {
        ctx.addIssue({
          code: "custom",
          path: ["schema", i],
          message: `${file} is listed twice`,
        });
      }
      seen.add(file);
    });
    if (Object.values(d1).every((v) => v === undefined)) {
      ctx.addIssue({
        code: "custom",
        message:
          "say at least one of migrationsDir, migrations, schema, postDeployMigrationsDir, seed",
      });
    }
  })
  .meta({
    not: { required: ["migrationsDir", "migrations"] },
    minProperties: 1,
  });
export type CatalogD1 = z.infer<typeof catalogD1Schema>;
