import { describe, expect, it } from "vitest";
import {
  buildMigrationQuery,
  CREATE_MIGRATIONS_TABLE_SQL,
  LIST_APPLIED_MIGRATIONS_SQL,
  unappliedMigrations,
} from "./d1-migrations";

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
});
