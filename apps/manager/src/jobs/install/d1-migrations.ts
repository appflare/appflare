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

/** Whether one file is recorded (used by a retried apply step before re-running it). */
export const APPLIED_MIGRATION_SQL = `SELECT name FROM "d1_migrations" WHERE name = ?`;

/** One `/query` call: the file's SQL, then the row that records it. */
export function buildMigrationQuery(fileSql: string, fileName: string): string {
  return `${fileSql}
INSERT INTO "d1_migrations" (name)
values ('${fileName.replace(/'/g, "''")}');`;
}

/** Files not yet recorded in `d1_migrations`, in filename order. */
export function unappliedMigrations<T extends { name: string }>(
  files: readonly T[],
  appliedRows: ReadonlyArray<Record<string, unknown>>,
): T[] {
  const applied = new Set(appliedRows.map((row) => String(row.name)));
  return [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .filter((file) => !applied.has(file.name));
}
