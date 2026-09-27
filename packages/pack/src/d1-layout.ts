import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { type CatalogD1, compareMigrationNames, migrationsGlobBase } from "@appflare/schema";
import { schemaFileProblems } from "./sql-guard.ts";
import type { ResolvedWranglerConfig } from "./wrangler-config.ts";

/**
 * Collects each D1 binding's SQL for the artifact: its migrations (from the
 * wrangler config's `migrations_dir` and `migrations_pattern`, or the catalog
 * manifest's `resources.d1` folder or glob), its schema files, and its
 * post-deploy migrations. Paths in `resources.d1` are relative to the
 * checkout's root and must stay inside it, links included.
 *
 * Migrations are found, named and ordered exactly as wrangler 4.136.2 does
 * (`getD1MigrationFiles` in `workers-utils/src/d1-migrations.ts`): the files
 * under the migrations folder that match the pattern relative to it (dot
 * files and folders never match), each named by its path from that folder,
 * in wrangler's order. So a database migrated by wrangler and one migrated by
 * Appflare record the same names in `d1_migrations`.
 */

/** A D1 SQL file as the artifact records it. */
export interface D1File {
  /** Its name in `d1_migrations` (and in the logs). */
  name: string;
  /** Its path inside the zip. */
  path: string;
  bytes: Buffer;
}

/** D1 files by binding. */
export type D1Files = Record<string, D1File[]>;

/** Where each list lives in the zip, by binding: `<prefix>/<binding>/<name>`. */
export const D1_ZIP_DIRS = {
  migrations: "d1",
  schema: "d1-schema",
  postDeploy: "d1-post-deploy",
} as const;

/** wrangler's default `migrations_pattern`, relative to the migrations folder. */
const DEFAULT_PATTERN = "*.sql";

/**
 * The absolute path of `relative` inside `checkoutDir`, once it is known to
 * exist and to stay inside the checkout after links are followed.
 */
function insideCheckout(checkoutDir: string, relative: string, what: string): string {
  const abs = path.resolve(checkoutDir, relative);
  if (!existsSync(abs)) {
    throw new Error(`${what} ${relative} does not exist in the checkout`);
  }
  const root = realpathSync(checkoutDir);
  const real = realpathSync(abs);
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${what} ${relative} leads outside the checkout`);
  }
  return real;
}

/** wrangler's `normalizeRelativePath`: `/` separators, normalised, no trailing `/`. */
function normalizeRelativePath(p: string): string {
  const normalized = path.posix.normalize(p.replace(/\\/g, "/"));
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** A glob match with minimatch's rules (dot files never match), as wrangler matches. */
function matchesGlob(file: string, pattern: string): boolean {
  // Node's `path.matchesGlob` is minimatch with `dot: false`, the options
  // wrangler passes; it exists from Node.js 22.5.
  const posix: Partial<Pick<typeof path.posix, "matchesGlob">> = path.posix;
  if (posix.matchesGlob === undefined) {
    throw new Error("reading D1 migrations needs Node.js 22.5 or newer (path.matchesGlob)");
  }
  return posix.matchesGlob(file, pattern);
}

/**
 * Whether files under the folder `relDir` could match `pattern`, as
 * minimatch's partial match tells wrangler: each of its segments must match
 * the pattern's segment at that depth, up to a `**`, and the pattern must go
 * deeper than the folder. Folders that cannot hold a match (`node_modules`
 * beside `migrations/*.sql`, dot folders) are never read.
 */
export function mayHoldMatches(relDir: string, pattern: string): boolean {
  const dirSegments = relDir.split("/");
  const patternSegments = pattern.split("/");
  for (const [i, segment] of dirSegments.entries()) {
    const want = patternSegments[i];
    if (want === "**") return !segment.startsWith(".");
    // The last pattern segment names files, so a folder at that depth holds none.
    if (want === undefined || i === patternSegments.length - 1) return false;
    if (!matchesGlob(segment, want)) return false;
  }
  return true;
}

/**
 * The migration files under `dir` that `pattern` (relative to `dir`)
 * matches, named by their `/`-separated path from `dir`, in wrangler's order
 * ({@link compareMigrationNames}). Like wrangler, links are neither files
 * nor folders here, so none is followed.
 */
export function listMigrationFiles(
  dir: string,
  pattern: string = DEFAULT_PATTERN,
): Array<{ name: string; abs: string }> {
  const found: Array<{ name: string; abs: string }> = [];
  const stack = [{ abs: dir, rel: "" }];
  while (stack.length > 0) {
    const { abs, rel } = stack.pop() as { abs: string; rel: string };
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        if (mayHoldMatches(childRel, pattern)) stack.push({ abs: childAbs, rel: childRel });
      } else if (entry.isFile() && matchesGlob(childRel, pattern)) {
        found.push({ name: childRel, abs: childAbs });
      }
    }
  }
  return found.sort((a, b) => compareMigrationNames(a.name, b.name));
}

/**
 * The files a catalog migrations glob matches: its folder is the glob's
 * segments before the first `*` ({@link migrationsGlobBase}), as wrangler's
 * `migrations_dir` is, and the rest is the pattern, as its
 * `migrations_pattern` is. `prisma/migrations/*\/migration.sql` records
 * `20240101_init/migration.sql`.
 */
export function expandMigrationsGlob(
  checkoutDir: string,
  glob: string,
): Array<{ name: string; abs: string }> {
  const base = migrationsGlobBase(glob);
  const baseDir =
    base === "." ? path.resolve(checkoutDir) : insideCheckout(checkoutDir, base, "the folder");
  if (!statSync(baseDir).isDirectory()) {
    throw new Error(`${base} in the migrations glob ${glob} is not a folder`);
  }
  const pattern = base === "." ? glob : glob.slice(base.length + 1);
  const found = listMigrationFiles(baseDir, pattern);
  if (found.length === 0) {
    throw new Error(`the migrations glob ${glob} matches no file in the checkout`);
  }
  return found;
}

function read(files: Array<{ name: string; abs: string }>, dir: string, binding: string): D1File[] {
  return files.map((f) => ({
    name: f.name,
    path: `${dir}/${binding}/${f.name}`,
    bytes: readFileSync(f.abs),
  }));
}

/** The catalog manifest's layout for `binding`, if it declares one. */
function layoutOf(declared: Record<string, CatalogD1> | undefined, binding: string) {
  return declared !== undefined && Object.hasOwn(declared, binding) ? declared[binding] : undefined;
}

/**
 * wrangler's `migrations_dir` and `migrations_pattern` of one D1 binding: the
 * folder (normalised, default `migrations`) and the pattern relative to it
 * (default `*.sql`). A pattern must start with the folder, and needs one,
 * or wrangler refuses the config (`resolveMigrationsConfig`).
 */
export function wranglerMigrationsLayout(d1: {
  binding: string;
  migrations_dir?: string | null;
  migrations_pattern?: string | null;
}): { dir: string; pattern: string } {
  const rawDir = d1.migrations_dir ?? undefined;
  const rawPattern = d1.migrations_pattern ?? undefined;
  if (rawPattern !== undefined && rawDir === undefined) {
    throw new Error(
      `the D1 binding ${d1.binding} sets migrations_pattern without migrations_dir, which wrangler refuses`,
    );
  }
  const dir = normalizeRelativePath(rawDir ?? "migrations");
  if (rawPattern === undefined) return { dir, pattern: DEFAULT_PATTERN };
  const pattern = normalizeRelativePath(rawPattern);
  if (dir === ".") return { dir, pattern };
  if (!pattern.startsWith(`${dir}/`)) {
    throw new Error(
      `the migrations_pattern "${rawPattern}" of the D1 binding ${d1.binding} must start with its migrations_dir "${dir}/", as wrangler requires`,
    );
  }
  return { dir, pattern: pattern.slice(dir.length + 1) };
}

/**
 * The migrations of one Worker's D1 bindings, by binding, in wrangler's
 * order. A binding the catalog manifest gives a `migrations` glob or a
 * `migrationsDir` takes its files from there (the folder must exist);
 * any other reads the wrangler config's `migrations_dir` and
 * `migrations_pattern`, and has none when the folder is missing.
 *
 * `configDirs` are the folders `migrations_dir` may be relative to, first
 * match wins: the declared config's folder, then the folder of the config
 * the build redirected wrangler to. `wrangler d1 migrations apply` reads the
 * declared config and never follows the deploy redirect (wrangler 4.136.2,
 * `resolveMigrationsConfig` takes the path of the config it found without
 * `useRedirectIfAvailable`), while a generated config (the Cloudflare Vite
 * plugin's `build/server/wrangler.json`) usually copies `migrations_dir`
 * unchanged, so beside it the folder is missing.
 */
export function collectD1Migrations(
  config: ResolvedWranglerConfig,
  configDirs: readonly string[],
  checkoutDir: string,
  declared: Record<string, CatalogD1> | undefined,
): D1Files {
  const result: D1Files = {};
  for (const d1 of config.d1_databases ?? []) {
    const layout = layoutOf(declared, d1.binding);
    let files: Array<{ name: string; abs: string }>;
    if (layout?.migrations !== undefined) {
      files = expandMigrationsGlob(checkoutDir, layout.migrations);
    } else if (layout?.migrationsDir !== undefined) {
      const dir = insideCheckout(checkoutDir, layout.migrationsDir, "resources.d1 migrationsDir");
      if (!statSync(dir).isDirectory()) {
        throw new Error(`resources.d1 migrationsDir ${layout.migrationsDir} is not a folder`);
      }
      files = listMigrationFiles(dir);
    } else {
      const { dir: migrationsDir, pattern } = wranglerMigrationsLayout(d1);
      const isDir = (dir: string) => existsSync(dir) && statSync(dir).isDirectory();
      const found = configDirs.map((base) => path.resolve(base, migrationsDir)).find(isDir);
      // The folder wrangler would read must be the checkout's, links included.
      const dir =
        found === undefined
          ? undefined
          : insideCheckout(checkoutDir, path.relative(checkoutDir, found), "migrations_dir");
      files = dir === undefined ? [] : listMigrationFiles(dir, pattern);
    }
    result[d1.binding] = read(files, D1_ZIP_DIRS.migrations, d1.binding);
  }
  return result;
}

/** The schema files and post-deploy migrations the catalog manifest declares. */
export interface D1Extras {
  schema: D1Files;
  postDeploy: D1Files;
}

/**
 * Reads the schema files and post-deploy migrations of `resources.d1`.
 * Refuses a declaration for a name no Worker binds as D1, a schema file that
 * is not safe to run on every install and update (see sql-guard.ts), and a
 * post-deploy migration named like one of the binding's migrations: both are
 * recorded in `d1_migrations` by name, so one of the two would never run.
 */
export function collectD1Extras(
  checkoutDir: string,
  declared: Record<string, CatalogD1> | undefined,
  bound: ReadonlySet<string>,
  migrations: D1Files,
): D1Extras {
  const schema: D1Files = {};
  const postDeploy: D1Files = {};
  for (const [binding, layout] of Object.entries(declared ?? {})) {
    if (!bound.has(binding)) {
      throw new Error(
        `resources.d1.${binding} describes a D1 binding the wrangler config does not have; ` +
          `bind a D1 database as ${binding} or remove resources.d1.${binding}`,
      );
    }
    if (layout.schema !== undefined) {
      schema[binding] = layout.schema.map((file) => {
        const abs = insideCheckout(checkoutDir, file, "the schema file");
        if (!statSync(abs).isFile()) throw new Error(`the schema file ${file} is not a file`);
        const bytes = readFileSync(abs);
        const problems = schemaFileProblems(bytes.toString("utf8"));
        if (problems.length > 0) {
          throw new Error(
            `the schema file ${file} of resources.d1.${binding} cannot run on every install and update: ${problems.join("; ")}`,
          );
        }
        return { name: file, path: `${D1_ZIP_DIRS.schema}/${binding}/${file}`, bytes };
      });
    }
    if (layout.postDeployMigrationsDir !== undefined) {
      const dir = insideCheckout(
        checkoutDir,
        layout.postDeployMigrationsDir,
        "resources.d1 postDeployMigrationsDir",
      );
      if (!statSync(dir).isDirectory()) {
        throw new Error(
          `resources.d1 postDeployMigrationsDir ${layout.postDeployMigrationsDir} is not a folder`,
        );
      }
      const files = read(listMigrationFiles(dir), D1_ZIP_DIRS.postDeploy, binding);
      const tracked = new Set((migrations[binding] ?? []).map((f) => f.name));
      const clash = files.find((f) => tracked.has(f.name));
      if (clash !== undefined) {
        throw new Error(
          `the post-deploy migration ${clash.name} of ${binding} has the name of one of its migrations; ` +
            "both are recorded in d1_migrations by name, so rename one of them",
        );
      }
      if (files.length > 0) postDeploy[binding] = files;
    }
  }
  return { schema, postDeploy };
}
