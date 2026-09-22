import { migrations as MIGRATIONS } from "./migrations/index";
import {
  releaseSettingsLock,
  releaseSettingsLockStatement,
  tryAcquireSettingsLock,
} from "./settings-lock";

/**
 * Self-migration at boot. The manager applies its own Drizzle
 * migrations on the first request (or cron) an isolate serves after a deploy,
 * so no updater ever runs them.
 *
 * `settings.schema_version` holds how many migrations have been applied. When it
 * is behind, one isolate takes the `migration_lock` lease (a conditional write,
 * 60 s TTL) and applies every pending file in ONE D1 batch that also bumps
 * `schema_version` and releases the lease. A D1 batch is a transaction, so a
 * migration is either fully applied and recorded or not at all. Isolates that
 * lose the lock poll `schema_version` until it catches up.
 *
 * Bootstrap: on a fresh database the `settings` table (and so the lock row) does
 * not exist yet, so the first batch runs without the lease. That is still safe:
 * two racing isolates both submit a batch starting with `CREATE TABLE`; the
 * second one fails and rolls back, re-reads `schema_version`, and finds it done.
 *
 * A database AHEAD of this build (the Worker was rolled back) is left
 * alone: migrations are additive, and old code must keep serving.
 */

export interface Migration {
  tag: string;
  sql: string;
}

export interface MigrationOutcome {
  /** `schema_version` after the call. */
  schemaVersion: number;
  /** Tags applied by this call (empty when already current). */
  applied: string[];
}

export interface MigratorOptions {
  lockTtlMs?: number;
  retryDelayMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const SCHEMA_VERSION_KEY = "schema_version";
export const MIGRATION_LOCK_KEY = "migration_lock";

/** drizzle-kit separates statements in one file with this marker. */
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

/** Reads `settings.schema_version`; 0 when the database is fresh. */
export async function readSchemaVersion(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare("SELECT value FROM settings WHERE key = ?1")
      .bind(SCHEMA_VERSION_KEY)
      .first<{ value: string }>();
    return row ? Number(row.value) : 0;
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such table")) return 0;
    throw error;
  }
}

async function settingsTableExists(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
    .first<{ present: number }>();
  return row !== null;
}

export function createMigrator(migrations: readonly Migration[], options: MigratorOptions = {}) {
  const lockTtlMs = options.lockTtlMs ?? 60_000;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const maxWaitMs = options.maxWaitMs ?? 15_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const target = migrations.length;

  // Module-level state per migrator: once current, an isolate never checks again.
  // Only the completed result is shared. An in-flight migration promise is NOT
  // shared across requests: workerd ties I/O to the request that started it, so
  // waiters in other requests can hang or fail if that request is cancelled.
  // Concurrent requests each run their own `migrate`; the D1 lease serializes
  // the actual work and the losers just see `schema_version` catch up.
  let current: number | null = null;

  async function applyPending(
    db: D1Database,
    from: number,
    lockOwner: string | null,
  ): Promise<MigrationOutcome> {
    const pending = migrations.slice(from);
    const statements = pending.flatMap((m) => splitStatements(m.sql).map((sql) => db.prepare(sql)));
    statements.push(
      db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(SCHEMA_VERSION_KEY, String(target), now()),
    );
    if (lockOwner !== null) {
      statements.push(releaseSettingsLockStatement(db, MIGRATION_LOCK_KEY, lockOwner));
    }
    try {
      await db.batch(statements);
    } catch (error) {
      // Lost a bootstrap race (or another isolate got there first): fine if done.
      const version = await readSchemaVersion(db);
      if (version >= target) return { schemaVersion: version, applied: [] };
      const message = error instanceof Error ? error.message : String(error);
      throw new MigrationError(
        `Applying migrations ${pending.map((m) => m.tag).join(", ")} failed: ${message}`,
      );
    }
    return { schemaVersion: target, applied: pending.map((m) => m.tag) };
  }

  async function migrate(db: D1Database): Promise<MigrationOutcome> {
    let version = await readSchemaVersion(db);
    if (version >= target) return { schemaVersion: version, applied: [] };

    if (version === 0 && !(await settingsTableExists(db))) {
      return applyPending(db, 0, null);
    }

    const owner = crypto.randomUUID();
    const deadline = now() + maxWaitMs;
    for (;;) {
      if (await tryAcquireSettingsLock(db, MIGRATION_LOCK_KEY, owner, lockTtlMs, now())) {
        try {
          version = await readSchemaVersion(db);
          if (version >= target) return { schemaVersion: version, applied: [] };
          return await applyPending(db, version, owner);
        } finally {
          // No-op after a successful batch (it already released the lease).
          await releaseSettingsLock(db, MIGRATION_LOCK_KEY, owner).catch(() => undefined);
        }
      }
      if (now() >= deadline) {
        throw new MigrationError("Timed out waiting for another isolate to finish migrating");
      }
      await sleep(retryDelayMs);
      version = await readSchemaVersion(db);
      if (version >= target) return { schemaVersion: version, applied: [] };
    }
  }

  return {
    /** Idempotent and cheap once current: later calls return without touching D1. */
    async ensure(db: D1Database): Promise<MigrationOutcome> {
      if (current !== null) return { schemaVersion: current, applied: [] };
      const outcome = await migrate(db);
      current = outcome.schemaVersion;
      return outcome;
    },
  };
}

const manager = createMigrator(MIGRATIONS);

/** Runs at the top of the Worker's `fetch` and `scheduled`, before anything else. */
export function ensureMigrated(env: { DB: D1Database }): Promise<MigrationOutcome> {
  return manager.ensure(env.DB);
}
