import { describe, expect, it } from "vitest";
import {
  buildMigrationQuery,
  CREATE_MIGRATIONS_TABLE_SQL,
  D1_MIGRATIONS_STEP_BYTES,
  D1_MIGRATIONS_STEP_SUBREQUESTS,
  d1MigrationsStepCost,
  LIST_APPLIED_MIGRATIONS_SQL,
  nextMigrationBatch,
  unappliedMigrations,
} from "./d1-migrations";

/** `count` migration files of `size` bytes, `gap` bytes apart in the zip. */
function files(count: number, size: number, gap = 60) {
  return Array.from({ length: count }, (_, i) => ({
    name: `${String(i + 1).padStart(4, "0")}_m.sql`,
    path: `migrations/DB/${i + 1}.sql`,
    size,
    sha256: "0".repeat(64),
    offset: 100 + i * (size + gap),
  }));
}

describe("wrangler-style D1 migrations", () => {
  it("creates d1_migrations with wrangler's exact statement", () => {
    expect(CREATE_MIGRATIONS_TABLE_SQL).toBe(
      'CREATE TABLE IF NOT EXISTS "d1_migrations"(\n\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n);',
    );
    expect(LIST_APPLIED_MIGRATIONS_SQL).toBe('SELECT *\n\t\tFROM "d1_migrations"\n\t\tORDER BY id');
  });

  it("appends the tracking insert to the file's SQL", () => {
    expect(buildMigrationQuery("CREATE TABLE t (id INTEGER);", "0001_init.sql")).toBe(
      "CREATE TABLE t (id INTEGER);\nINSERT INTO \"d1_migrations\" (name)\nvalues ('0001_init.sql');",
    );
  });

  it("escapes quotes in file names", () => {
    expect(buildMigrationQuery("", "0002_it's.sql")).toContain("values ('0002_it''s.sql');");
  });

  it("returns the unapplied files in filename order", () => {
    const files = [{ name: "0003_c.sql" }, { name: "0001_a.sql" }, { name: "0002_b.sql" }];
    expect(unappliedMigrations(files, [{ id: 1, name: "0001_a.sql" }]).map((f) => f.name)).toEqual([
      "0002_b.sql",
      "0003_c.sql",
    ]);
  });

  it("orders files by their leading number, as wrangler applies them", () => {
    const named = ["10_c.sql", "9_b/migration.sql", "1_a.sql"].map((name) => ({ name }));
    expect(unappliedMigrations(named, []).map((f) => f.name)).toEqual([
      "1_a.sql",
      "9_b/migration.sql",
      "10_c.sql",
    ]);
  });
});

describe("nextMigrationBatch", () => {
  it("takes 30 adjacent files in one call, within the unit budget", () => {
    const batch = nextMigrationBatch(files(30, 1_200));
    expect(batch).toHaveLength(30);
    expect(d1MigrationsStepCost(1, 30)).toBe(34);
    expect(D1_MIGRATIONS_STEP_SUBREQUESTS).toBeLessThan(40);
  });

  it("stops where the next file would pass the subrequest budget", () => {
    expect(nextMigrationBatch(files(50, 1_200))).toHaveLength(32);
  });

  it("counts a range per file that is not next to the previous one", () => {
    // 1 MiB gaps: every file needs its own range, so each costs two.
    const batch = nextMigrationBatch(files(40, 1_000, 1024 * 1024));
    expect(batch).toHaveLength(16);
    expect(d1MigrationsStepCost(16, 16)).toBe(35);
  });

  it("stops where the next file would pass the byte cap, but always takes one", () => {
    const big = D1_MIGRATIONS_STEP_BYTES / 2 + 1;
    expect(nextMigrationBatch(files(3, big))).toHaveLength(1);
    expect(nextMigrationBatch(files(1, D1_MIGRATIONS_STEP_BYTES * 2))).toHaveLength(1);
  });

  it("keeps the given order", () => {
    const shuffled = files(3, 100).reverse();
    expect(nextMigrationBatch(shuffled).map((f) => f.name)).toEqual(shuffled.map((f) => f.name));
  });
});
