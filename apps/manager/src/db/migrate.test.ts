import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createMigrator,
  MIGRATION_LOCK_KEY,
  MigrationError,
  readSchemaVersion,
  SCHEMA_VERSION_KEY,
  splitStatements,
} from "./migrate";
import { migrations } from "./migrations/index";
import journal from "./migrations/meta/_journal.json";

const EXPECTED_TABLES = [
  "account",
  "catalog_revisions",
  "featured_dismissals",
  "installs",
  "job_logs",
  "jobs",
  "notification_channels",
  "notification_deliveries",
  "notification_events",
  "passkey",
  "rate_limit",
  "resources",
  "session",
  "settings",
  "snapshots",
  "source_builds",
  "user",
  "verification",
];

async function tableNames(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

async function columnNames(db: D1Database, table: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM pragma_table_info(?1)")
    .bind(table)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

async function settingValue(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/** Counts `prepare` calls so a test can prove a call never touched D1. */
function countingDb(db: D1Database): { db: D1Database; prepares: () => number } {
  let n = 0;
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          n++;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, prepares: () => n };
}

const extra = { tag: "9999_extra", sql: "CREATE TABLE `extra` (`id` text PRIMARY KEY NOT NULL);" };

beforeEach(async () => {
  await reset();
});

describe("migrations index", () => {
  it("lists every journal entry in order", () => {
    expect(migrations.map((m) => m.tag)).toEqual(journal.entries.map((e) => e.tag));
    for (const m of migrations) expect(m.sql.length).toBeGreaterThan(0);
  });

  it("splits drizzle statement breakpoints", () => {
    expect(splitStatements("A;\n--> statement-breakpoint\nB;\n")).toEqual(["A;", "B;"]);
  });
});

describe("ensure", () => {
  it("creates every table on a fresh database and records the version", async () => {
    expect(await readSchemaVersion(env.DB)).toBe(0);
    const outcome = await createMigrator(migrations).ensure(env.DB);
    expect(outcome).toEqual({
      schemaVersion: migrations.length,
      applied: migrations.map((m) => m.tag),
    });
    expect(await tableNames(env.DB)).toEqual(EXPECTED_TABLES);
    expect(await settingValue(env.DB, SCHEMA_VERSION_KEY)).toBe(String(migrations.length));
    expect(await settingValue(env.DB, MIGRATION_LOCK_KEY)).toBeNull();
  });

  it("adds the uninstall columns on top of a database at the previous version", async () => {
    const before = migrations.findIndex((m) => m.tag === "0002_uninstall");
    expect(before).toBeGreaterThan(0);
    await createMigrator(migrations.slice(0, before)).ensure(env.DB);
    expect(await columnNames(env.DB, "installs")).not.toContain("uninstalled_at");
    const outcome = await createMigrator(migrations).ensure(env.DB);
    expect(outcome.applied).toEqual(migrations.slice(before).map((m) => m.tag));
    expect(await columnNames(env.DB, "installs")).toContain("uninstalled_at");
    expect(await columnNames(env.DB, "resources")).toContain("retained_at");
    // Both are nullable: rows written before the upgrade stay valid.
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status, installed_at, updated_at)
       VALUES ('i1', 'cut', 'cut', '1', 'u', 'installed', 1, 1)`,
    ).run();
    const row = await env.DB.prepare("SELECT uninstalled_at FROM installs WHERE id = 'i1'").first();
    expect(row).toEqual({ uninstalled_at: null });
  });

  it("carries existing domains and workers.dev switches over to the automatic default", async () => {
    const before = migrations.findIndex((m) => m.tag === "0018_workers_dev_choice");
    expect(before).toBeGreaterThan(0);
    await createMigrator(migrations.slice(0, before)).ensure(env.DB);
    const install = (id: string, workersDev: number, served: string | null) =>
      env.DB.prepare(
        `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status,
           workers_dev_enabled, served_domain, installed_at, updated_at)
         VALUES (?1, 'cut', ?1, '1', 'u', 'installed', ?2, ?3, 1, 1)`,
      ).bind(id, workersDev, served);
    const domain = (
      id: string,
      installId: string,
      kind: string,
      name: string,
      cfId: string | null,
    ) =>
      env.DB.prepare(
        `INSERT INTO resources (id, install_id, kind, name, cf_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 7)`,
      ).bind(id, installId, kind, name, cfId);
    await env.DB.batch([
      // No domain: Appflare decides from now on.
      install("plain", 1, null),
      // workers.dev on beside a domain: left as the admin has had it.
      install("kept", 1, null),
      domain("kept:d", "kept", "domain", "a.example.com", "cfd-1"),
      domain("kept:x", "kept", "custom_hostname", "pending.customer.test", "z/ch-1"),
      // Turned off with the switch: the admin's choice.
      install("off", 0, "go.customer.test"),
      domain("off:x", "off", "custom_hostname", "go.customer.test", "z/ch-2"),
      domain("off:y", "off", "custom_hostname", "active.customer.test", "z/ch-3"),
      env.DB.prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ('external_domain_state:off:y', '{"state":"active","since":5}', 5)`,
      ),
    ]);
    await createMigrator(migrations).ensure(env.DB);
    const installs = await env.DB.prepare(
      "SELECT id, workers_dev_choice FROM installs ORDER BY id",
    ).all();
    expect(installs.results).toEqual([
      { id: "kept", workers_dev_choice: "manual" },
      { id: "off", workers_dev_choice: "manual" },
      { id: "plain", workers_dev_choice: "auto" },
    ]);
    const live = await env.DB.prepare("SELECT id, live_at FROM resources ORDER BY id").all();
    expect(live.results).toEqual([
      { id: "kept:d", live_at: 7 },
      { id: "kept:x", live_at: null },
      { id: "off:x", live_at: 7 },
      { id: "off:y", live_at: 7 },
    ]);
  });

  it("is a no-op on the second call (no D1 access at all)", async () => {
    const migrator = createMigrator(migrations);
    await migrator.ensure(env.DB);
    const counted = countingDb(env.DB);
    expect(await migrator.ensure(counted.db)).toEqual({
      schemaVersion: migrations.length,
      applied: [],
    });
    expect(counted.prepares()).toBe(0);
  });

  it("is a no-op for a new isolate when the database is already current", async () => {
    await createMigrator(migrations).ensure(env.DB);
    const outcome = await createMigrator(migrations).ensure(env.DB);
    expect(outcome).toEqual({ schemaVersion: migrations.length, applied: [] });
    expect(await settingValue(env.DB, MIGRATION_LOCK_KEY)).toBeNull();
  });

  it("lets concurrent calls migrate independently (no shared in-flight promise)", async () => {
    await createMigrator(migrations).ensure(env.DB);
    const migrator = createMigrator([...migrations, extra], { retryDelayMs: 5 });
    const outcomes = await Promise.all([migrator.ensure(env.DB), migrator.ensure(env.DB)]);
    expect(outcomes.map((o) => o.schemaVersion)).toEqual([
      migrations.length + 1,
      migrations.length + 1,
    ]);
    expect(outcomes.flatMap((o) => o.applied)).toEqual([extra.tag]);
    expect(await settingValue(env.DB, MIGRATION_LOCK_KEY)).toBeNull();
  });

  it("applies a new migration under the lock and releases it", async () => {
    await createMigrator(migrations).ensure(env.DB);
    const outcome = await createMigrator([...migrations, extra]).ensure(env.DB);
    expect(outcome).toEqual({ schemaVersion: migrations.length + 1, applied: [extra.tag] });
    expect(await tableNames(env.DB)).toContain("extra");
    expect(await settingValue(env.DB, SCHEMA_VERSION_KEY)).toBe(String(migrations.length + 1));
    expect(await settingValue(env.DB, MIGRATION_LOCK_KEY)).toBeNull();
  });

  it("waits while another isolate holds the lock, then sees its result", async () => {
    await createMigrator(migrations).ensure(env.DB);
    const now = Date.now();
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, 'other', ?2)")
      .bind(MIGRATION_LOCK_KEY, now)
      .run();
    let sleeps = 0;
    const migrator = createMigrator([...migrations, extra], {
      now: () => now,
      sleep: async () => {
        sleeps++;
        // The other isolate finishes: applies `extra`, bumps the version, releases.
        await env.DB.batch([
          env.DB.prepare(extra.sql),
          env.DB.prepare("UPDATE settings SET value = ?1 WHERE key = ?2").bind(
            String(migrations.length + 1),
            SCHEMA_VERSION_KEY,
          ),
          env.DB.prepare("DELETE FROM settings WHERE key = ?1").bind(MIGRATION_LOCK_KEY),
        ]);
      },
    });
    expect(await migrator.ensure(env.DB)).toEqual({
      schemaVersion: migrations.length + 1,
      applied: [],
    });
    expect(sleeps).toBe(1);
  });

  it("takes over a lock older than its TTL", async () => {
    await createMigrator(migrations).ensure(env.DB);
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, 'dead', ?2)")
      .bind(MIGRATION_LOCK_KEY, Date.now() - 61_000)
      .run();
    const outcome = await createMigrator([...migrations, extra]).ensure(env.DB);
    expect(outcome.applied).toEqual([extra.tag]);
    expect(await settingValue(env.DB, MIGRATION_LOCK_KEY)).toBeNull();
  });

  it("gives up after maxWaitMs when the lock is never released", async () => {
    await createMigrator(migrations).ensure(env.DB);
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, 'other', ?2)")
      .bind(MIGRATION_LOCK_KEY, Date.now())
      .run();
    let t = Date.now();
    const migrator = createMigrator([...migrations, extra], {
      maxWaitMs: 1_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    await expect(migrator.ensure(env.DB)).rejects.toBeInstanceOf(MigrationError);
    expect(await settingValue(env.DB, MIGRATION_LOCK_KEY)).toBe("other");
  });

  it("leaves a database that is ahead of the build alone (rolled-back Worker)", async () => {
    await createMigrator([...migrations, extra]).ensure(env.DB);
    const outcome = await createMigrator(migrations).ensure(env.DB);
    expect(outcome).toEqual({ schemaVersion: migrations.length + 1, applied: [] });
  });

  it("rolls back a failing migration entirely and reports it", async () => {
    await createMigrator(migrations).ensure(env.DB);
    const broken = {
      tag: "9998_broken",
      sql: "CREATE TABLE `ok` (`id` text);\n--> statement-breakpoint\nNOT SQL;",
    };
    await expect(createMigrator([...migrations, broken]).ensure(env.DB)).rejects.toThrow(
      /9998_broken/,
    );
    expect(await tableNames(env.DB)).not.toContain("ok");
    expect(await settingValue(env.DB, SCHEMA_VERSION_KEY)).toBe(String(migrations.length));
    expect(await settingValue(env.DB, MIGRATION_LOCK_KEY)).toBeNull();
  });
});
