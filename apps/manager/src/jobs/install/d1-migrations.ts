import {
  compareMigrationNames,
  endsInsideStatement,
  planSpans,
  SPAN_LIMITS,
} from "@appflare/schema";
import type { ArtifactFileRef } from "./artifact";
import { ARTIFACT_FETCH_COST } from "./budget";

/**
 * D1 migrations applied the way `wrangler d1 migrations apply --remote` does.
 * Strings are verbatim from wrangler 4.136.2
 * (`src/d1/migrations/helpers.ts`: `getCreateMigrationsTableQuery`,
 * `getListAppliedMigrationsQuery`, `buildMigrationQuery`), so a database set up
 * by Appflare and one set up by wrangler are interchangeable.
 */

export const CREATE_MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

export const LIST_APPLIED_MIGRATIONS_SQL = `SELECT *
		FROM "d1_migrations"
		ORDER BY id`;

/** One `/query` call: the file's SQL, then the row that records it. */
export function buildMigrationQuery(fileSql: string, fileName: string): string {
  return `${fileSql}
INSERT INTO "d1_migrations" (name)
values ('${fileName.replace(/'/g, "''")}');`;
}

/*
 * A baseline (`resources.d1[binding].baseline` in the catalog manifest) is
 * the app's whole current schema, for apps whose migrations only bring older
 * databases up to date. It runs once, on the database the install has just
 * created, in one `/query` call together with the rows that record every
 * migration the version ships, so those never run there. D1 runs a query of
 * several statements as one transaction: when a statement fails, none of
 * them applies (verified against the D1 REST API, 2026-09-27: a failing
 * third statement left the first two's table absent).
 *
 * Whether a database already ran its baseline is read from its tables, not
 * from a row: a baseline creates at least one table (the packer refuses one
 * that creates none), and the database was empty before it.
 */

/**
 * How many of the app's own tables a database has (every table but
 * `d1_migrations`, SQLite's and D1's own; a new database holds `_cf_KV`),
 * and how many migrations `d1_migrations` records (it must exist). A
 * baseline runs only where both are 0.
 */
export const BASELINE_STATE_SQL = `SELECT (SELECT count(*) FROM sqlite_master
		WHERE type = 'table' AND name <> 'd1_migrations'
		AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_') AS tables,
	(SELECT count(*) FROM "d1_migrations") AS recorded`;

/** The query that records `names` as applied; empty when there are none. Already recorded names stay. */
export function recordMigrationsQuery(names: readonly string[]): string {
  if (names.length === 0) return "";
  const rows = names.map((name) => `('${name.replace(/'/g, "''")}')`).join(",\n");
  return `INSERT OR IGNORE INTO "d1_migrations" (name)
values ${rows};`;
}

/** One `/query` call: the baseline's SQL, then the rows that record `names` as applied. */
export function buildBaselineQuery(fileSql: string, names: readonly string[]): string {
  const record = recordMigrationsQuery(names);
  if (record === "") return fileSql;
  // A last statement without its `;` would run into the insert, and a `;`
  // after one that has it is an empty statement, which D1 refuses.
  const closed = endsInsideStatement(fileSql) ? `${fileSql}\n;` : fileSql;
  return `${closed}\n${record}`;
}

/** Recorded names this version does not ship, in the order they were recorded. */
export function unshippedMigrations(
  shipped: readonly string[],
  appliedRows: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const known = new Set(shipped);
  return appliedRows.map((row) => String(row.name)).filter((name) => !known.has(name));
}

/** Files not yet recorded in `d1_migrations`, in the order wrangler applies them. */
export function unappliedMigrations<T extends { name: string }>(
  files: readonly T[],
  appliedRows: ReadonlyArray<Record<string, unknown>>,
): T[] {
  const applied = new Set(appliedRows.map((row) => String(row.name)));
  return [...files]
    .sort((a, b) => compareMigrationNames(a.name, b.name))
    .filter((file) => !applied.has(file.name));
}

/*
 * How many migration files one call of the `applyD1Migrations` unit applies.
 *
 * A call ensures `d1_migrations` exists and lists what is applied (one query
 * each), reads the next files from the artifact (the packer writes them next
 * to each other, so usually with one Range request, plus the release-asset
 * redirect once), then applies them one `/query` call per file, with the row
 * that records the file in the same query, as wrangler does. So a file costs
 * one subrequest plus its share of the ranges, and 30 adjacent files fit one
 * call: 2 + 2 + 30 = 34.
 */

/** Subrequests one call may make: under 40, like every job unit. */
export const D1_MIGRATIONS_STEP_SUBREQUESTS = 36;

/**
 * Bytes of SQL one call reads at most. Each file is still its own query, so
 * D1's per-statement limit (100 KB) applies as it does to wrangler; this cap
 * bounds what one call downloads and holds, one full Range request. One
 * larger file still gets a call of its own.
 */
export const D1_MIGRATIONS_STEP_BYTES = SPAN_LIMITS.maxBytes;

/** The table check and the list of applied files, once per call. */
const MIGRATIONS_CALL_OVERHEAD = 2;

/** Worst-case subrequests of a call that reads `ranges` ranges and applies `files` files. */
export function d1MigrationsStepCost(
  ranges: number,
  files: number,
  overhead: number = MIGRATIONS_CALL_OVERHEAD,
): number {
  const fetches = ranges === 0 ? 0 : ARTIFACT_FETCH_COST + ranges - 1;
  return overhead + fetches + files;
}

export interface MigrationBatchLimits {
  subrequests: number;
  bytes: number;
  /**
   * Subrequests a call makes besides reading and running the files: the
   * table check and the list for tracked migrations (the default), none for
   * schema files ({@link D1_SCHEMA_LIMITS}).
   */
  overhead?: number;
}

/*
 * Schema files (`resources.d1[binding].schema` in the catalog manifest) run
 * on every install and update after the tracked migrations and are never
 * recorded, so a call runs them one `/query` call per file, in the order the
 * catalog lists them, with nothing to check first. Running one again is
 * harmless: the packer accepts only files whose every CREATE says
 * IF NOT EXISTS and that drop and alter nothing.
 */

/** The limits of one call that runs schema files. */
export const D1_SCHEMA_LIMITS: MigrationBatchLimits = {
  subrequests: D1_MIGRATIONS_STEP_SUBREQUESTS,
  bytes: D1_MIGRATIONS_STEP_BYTES,
  overhead: 0,
};

/**
 * The files one call applies: the longest prefix of `pending` (already in the
 * order they must run) whose ranges and queries fit the limits. Always at
 * least one file, so every call makes progress.
 */
export function nextMigrationBatch<F extends ArtifactFileRef>(
  pending: readonly F[],
  limits: MigrationBatchLimits = {
    subrequests: D1_MIGRATIONS_STEP_SUBREQUESTS,
    bytes: D1_MIGRATIONS_STEP_BYTES,
  },
): F[] {
  let bytes = 0;
  let count = 0;
  for (const file of pending) {
    const next = pending.slice(0, count + 1);
    const cost = d1MigrationsStepCost(planSpans(next).length, next.length, limits.overhead);
    if (count > 0 && (cost > limits.subrequests || bytes + file.size > limits.bytes)) break;
    bytes += file.size;
    count += 1;
  }
  return pending.slice(0, count);
}
