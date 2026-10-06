import { migrations as MIGRATIONS } from "./migrations/index";

/**
 * The installer applies its own schema on the first request each isolate
 * serves, as the manager does, rather than through `wrangler d1 migrations
 * apply` in the deploy: the Worker then never serves a version whose tables
 * are missing, whichever pipeline deployed it, and the database wrangler
 * creates on the first production deploy needs no second command.
 *
 * `_migrations` records each applied migration under its version number
 * (1-based). Pending migrations go in ONE D1 batch (a transaction), each
 * starting with the insert of its own row: an isolate that races another one
 * fails on that primary key, its batch rolls back whole, and it finds the
 * work done when it reads again. A database ahead of this build (an older
 * version rolled back over a newer one) is left alone; migrations only add.
 */

export interface Migration {
  tag: string;
  sql: string;
}

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export class MigrationError extends Error {
  override name = "MigrationError";
}

export function splitStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const CREATE_TABLE =
  "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, tag TEXT NOT NULL, applied_at INTEGER NOT NULL)";

async function appliedVersion(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM _migrations")
    .first<{ version: number }>();
  return Number(row?.version ?? 0);
}

export function createMigrator(migrations: readonly Migration[]) {
  const target = migrations.length;
  let current: number | null = null;

  async function migrate(db: D1Database): Promise<number> {
    await db.prepare(CREATE_TABLE).run();
    const from = await appliedVersion(db);
    if (from >= target) return from;
    const statements = migrations
      .slice(from)
      .flatMap((m, i) => [
        db
          .prepare("INSERT INTO _migrations (version, tag, applied_at) VALUES (?1, ?2, ?3)")
          .bind(from + i + 1, m.tag, Date.now()),
        ...splitStatements(m.sql).map((sql) => db.prepare(sql)),
      ]);
    try {
      await db.batch(statements);
    } catch (error) {
      const version = await appliedVersion(db);
      if (version >= target) return version;
      throw new MigrationError(
        `applying ${migrations
          .slice(from)
          .map((m) => m.tag)
          .join(", ")} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return target;
  }

  return {
    /** Idempotent, and free once this isolate has seen the schema current. */
    async ensure(db: D1Database): Promise<number> {
      if (current !== null) return current;
      current = await migrate(db);
      return current;
    },
  };
}

const installer = createMigrator(MIGRATIONS);

/** Runs before every request is handled. */
export function ensureMigrated(db: D1Database): Promise<number> {
  return installer.ensure(db);
}
