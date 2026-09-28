import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectD1Extras,
  collectD1Migrations,
  expandMigrationsGlob,
  mayHoldMatches,
  wranglerMigrationsLayout,
} from "./d1-layout.ts";
import type { ResolvedWranglerConfig } from "./wrangler-config.ts";

let root: string;
let checkout: string;

/** Writes `files` (path relative to the checkout: contents) into the checkout. */
function files(entries: Record<string, string>): void {
  for (const [rel, content] of Object.entries(entries)) {
    const abs = path.join(checkout, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

const config = (migrationsDir?: string): ResolvedWranglerConfig => ({
  d1_databases: [
    migrationsDir === undefined
      ? { binding: "DB" }
      : { binding: "DB", migrations_dir: migrationsDir },
  ],
});

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "appflare-d1-layout-"));
  checkout = path.join(root, "checkout");
  mkdirSync(checkout);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("expandMigrationsGlob", () => {
  it("records Prisma's migrations by their path from the folder before the *, as wrangler does", () => {
    files({
      "prisma/migrations/20240201000000_add_clicks/migration.sql": "ALTER TABLE links ADD x;",
      "prisma/migrations/20240101000000_init/migration.sql": "CREATE TABLE links (id);",
      "prisma/migrations/20240115000000_index/migration.sql": "CREATE INDEX i ON links(id);",
      "prisma/migrations/migration_lock.toml": 'provider = "sqlite"',
      "prisma/migrations/20240301000000_draft/README.md": "no SQL yet",
      "prisma/migrations/.cache/migration.sql": "SELECT 1;",
    });
    const found = expandMigrationsGlob(checkout, "prisma/migrations/*/migration.sql");
    expect(found.map((f) => f.name)).toEqual([
      "20240101000000_init/migration.sql",
      "20240115000000_index/migration.sql",
      "20240201000000_add_clicks/migration.sql",
    ]);
    expect(path.relative(checkout, found[0]?.abs ?? "")).toBe(
      path.join("prisma", "migrations", "20240101000000_init", "migration.sql"),
    );
  });

  it("names files in the last segment by their own name, in wrangler's numeric order", () => {
    files({
      "db/10_c_up.sql": "",
      "db/9_b_up.sql": "",
      "db/1_a_up.sql": "",
      "db/1_a_down.sql": "",
      "db/2_x_up.SQL": "",
    });
    expect(expandMigrationsGlob(checkout, "db/*_up.sql").map((f) => f.name)).toEqual([
      "1_a_up.sql",
      "9_b_up.sql",
      "10_c_up.sql",
    ]);
  });

  it("fails when nothing matches, and never follows a link", () => {
    files({ "db/readme.md": "" });
    expect(() => expandMigrationsGlob(checkout, "db/*.sql")).toThrow(/matches no file/);
    expect(() => expandMigrationsGlob(checkout, "missing/*.sql")).toThrow(/does not exist/);
    writeFileSync(path.join(root, "outside.sql"), "SELECT 1;");
    symlinkSync(path.join(root, "outside.sql"), path.join(checkout, "db", "0001_x.sql"));
    expect(() => expandMigrationsGlob(checkout, "db/*.sql")).toThrow(/matches no file/);
    symlinkSync(root, path.join(checkout, "up"));
    expect(() => expandMigrationsGlob(checkout, "up/*.sql")).toThrow(/leads outside the checkout/);
  });
});

describe("mayHoldMatches", () => {
  it("reads only folders the pattern can reach", () => {
    expect(mayHoldMatches("20240101_init", "*/migration.sql")).toBe(true);
    expect(mayHoldMatches("20240101_init/nested", "*/migration.sql")).toBe(false);
    expect(mayHoldMatches("node_modules", "*.sql")).toBe(false);
    expect(mayHoldMatches(".cache", "*/migration.sql")).toBe(false);
    expect(mayHoldMatches("v1", "v*/up/*.sql")).toBe(true);
    expect(mayHoldMatches("v1/down", "v*/up/*.sql")).toBe(false);
    expect(mayHoldMatches("a/b/c", "a/**/*.sql")).toBe(true);
    expect(mayHoldMatches("a/.git", "a/**/*.sql")).toBe(false);
  });
});

describe("wranglerMigrationsLayout", () => {
  it("reads migrations_dir and migrations_pattern as wrangler does", () => {
    expect(wranglerMigrationsLayout({ binding: "DB" })).toEqual({
      dir: "migrations",
      pattern: "*.sql",
    });
    expect(
      wranglerMigrationsLayout({
        binding: "DB",
        migrations_dir: "./drizzle/",
        migrations_pattern: "drizzle/*/migration.sql",
      }),
    ).toEqual({ dir: "drizzle", pattern: "*/migration.sql" });
    expect(() =>
      wranglerMigrationsLayout({ binding: "DB", migrations_pattern: "m/*.sql" }),
    ).toThrow(/migrations_pattern without migrations_dir/);
    expect(() =>
      wranglerMigrationsLayout({
        binding: "DB",
        migrations_dir: "m",
        migrations_pattern: "x/*.sql",
      }),
    ).toThrow(/must start with its migrations_dir "m\/"/);
  });
});

describe("collectD1Migrations", () => {
  beforeEach(() => {
    files({
      "migrations/0001_config.sql": "CREATE TABLE a (id);",
      "worker/migrations/0002_b.sql": "CREATE TABLE b (id);",
      "worker/migrations/0001_a.sql": "CREATE TABLE a (id);",
      "worker/migrations/notes.txt": "",
    });
  });

  it("reads the wrangler config's folder when the catalog says nothing", () => {
    const d1 = collectD1Migrations(config(), [checkout], checkout, undefined);
    expect(d1.DB?.map((f) => [f.name, f.path])).toEqual([
      ["0001_config.sql", "d1/DB/0001_config.sql"],
    ]);
    expect(collectD1Migrations(config("none"), [checkout], checkout, undefined)).toEqual({
      DB: [],
    });
  });

  it("honours the wrangler config's migrations_pattern", () => {
    files({ "drizzle/0000_init/migration.sql": "", "drizzle/meta/_journal.json": "" });
    const d1 = collectD1Migrations(
      {
        d1_databases: [
          {
            binding: "DB",
            migrations_dir: "drizzle",
            migrations_pattern: "drizzle/*/migration.sql",
          },
        ],
      },
      [checkout],
      checkout,
      undefined,
    );
    expect(d1.DB?.map((f) => [f.name, f.path])).toEqual([
      ["0000_init/migration.sql", "d1/DB/0000_init/migration.sql"],
    ]);
  });

  it("reads migrations_dir beside the declared config first, then beside the redirected one", () => {
    files({ "build/server/migrations/0009_generated.sql": "" });
    const redirected = path.join(checkout, "build", "server");
    const first = collectD1Migrations(config(), [checkout, redirected], checkout, undefined);
    expect(first.DB?.map((f) => f.name)).toEqual(["0001_config.sql"]);
    rmSync(path.join(checkout, "migrations"), { recursive: true });
    const fallback = collectD1Migrations(config(), [checkout, redirected], checkout, undefined);
    expect(fallback.DB?.map((f) => f.name)).toEqual(["0009_generated.sql"]);
  });

  it("refuses a config migrations_dir that links outside the checkout", () => {
    mkdirSync(path.join(root, "elsewhere"));
    symlinkSync(path.join(root, "elsewhere"), path.join(checkout, "linked"));
    expect(() => collectD1Migrations(config("linked"), [checkout], checkout, undefined)).toThrow(
      /migrations_dir linked leads outside the checkout/,
    );
  });

  it("takes migrationsDir from the checkout's root instead of the config's folder", () => {
    const d1 = collectD1Migrations(config("migrations"), [checkout], checkout, {
      DB: { migrationsDir: "worker/migrations" },
    });
    expect(d1.DB?.map((f) => f.name)).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(() =>
      collectD1Migrations(config(), [checkout], checkout, { DB: { migrationsDir: "nowhere" } }),
    ).toThrow(/resources\.d1 migrationsDir nowhere does not exist/);
  });

  it("takes a glob's files under wrangler's names", () => {
    files({ "prisma/migrations/20240101_init/migration.sql": "CREATE TABLE p (id);" });
    const d1 = collectD1Migrations(config(), [checkout], checkout, {
      DB: { migrationsGlob: "prisma/migrations/*/migration.sql" },
    });
    expect(d1.DB?.map((f) => [f.name, f.path, f.bytes.toString()])).toEqual([
      ["20240101_init/migration.sql", "d1/DB/20240101_init/migration.sql", "CREATE TABLE p (id);"],
    ]);
  });
});

describe("collectD1Extras", () => {
  const bound = new Set(["DB"]);
  const migrations = {
    DB: [{ name: "0001_init.sql", path: "d1/DB/0001_init.sql", bytes: Buffer.from("") }],
  };

  it("reads a baseline as one file, and refuses one that may not run at install", () => {
    files({
      "db/schema.sql": "CREATE TABLE posts (id INTEGER);\nINSERT INTO posts VALUES (1);",
      "db/attach.sql": "CREATE TABLE a (id INTEGER);\nATTACH DATABASE 'x' AS x;",
    });
    const extras = collectD1Extras(
      checkout,
      { DB: { baseline: "db/schema.sql" } },
      bound,
      migrations,
    );
    expect(extras.baseline.DB?.map((f) => [f.name, f.path])).toEqual([
      ["db/schema.sql", "d1-baseline/DB/db/schema.sql"],
    ]);
    expect(extras.schema).toEqual({});
    expect(() =>
      collectD1Extras(checkout, { DB: { baseline: "db/attach.sql" } }, bound, migrations),
    ).toThrow(
      /the baseline db\/attach\.sql of resources\.d1\.DB cannot run at install: line 2: ATTACH reaches another database/,
    );
    expect(() =>
      collectD1Extras(checkout, { DB: { baseline: "db/missing.sql" } }, bound, migrations),
    ).toThrow(/the baseline db\/missing\.sql does not exist/);
  });

  it("reads schema files in the listed order and post-deploy migrations in name order", () => {
    files({
      "src/db/tables.sql": "CREATE TABLE IF NOT EXISTS t (id);",
      "src/db/indexes.sql": "CREATE INDEX IF NOT EXISTS i ON t(id);",
      "after/0002_drop_old.sql": "DROP TABLE old;",
      "after/0001_backfill.sql": "UPDATE t SET id = id;",
    });
    const extras = collectD1Extras(
      checkout,
      {
        DB: {
          schema: ["src/db/tables.sql", "src/db/indexes.sql"],
          postDeployMigrationsDir: "after",
        },
      },
      bound,
      migrations,
    );
    expect(extras.schema.DB?.map((f) => [f.name, f.path])).toEqual([
      ["src/db/tables.sql", "d1-schema/DB/src/db/tables.sql"],
      ["src/db/indexes.sql", "d1-schema/DB/src/db/indexes.sql"],
    ]);
    expect(extras.postDeploy.DB?.map((f) => [f.name, f.path])).toEqual([
      ["0001_backfill.sql", "d1-post-deploy/DB/0001_backfill.sql"],
      ["0002_drop_old.sql", "d1-post-deploy/DB/0002_drop_old.sql"],
    ]);
  });

  it("refuses a schema file that is not safe to run again, naming the file and line", () => {
    files({ "schema.sql": "CREATE TABLE IF NOT EXISTS a (id);\nCREATE TABLE b (id);" });
    expect(() =>
      collectD1Extras(checkout, { DB: { schema: ["schema.sql"] } }, bound, migrations),
    ).toThrow(
      /the schema file schema\.sql of resources\.d1\.DB cannot run on every install and update: line 2: CREATE TABLE b has no IF NOT EXISTS/,
    );
  });

  it("refuses a binding no Worker has, a missing file, and a name a migration already has", () => {
    files({ "schema.sql": "CREATE TABLE IF NOT EXISTS a (id);", "after/0001_init.sql": "" });
    expect(() =>
      collectD1Extras(checkout, { OTHER: { schema: ["schema.sql"] } }, bound, migrations),
    ).toThrow(/resources\.d1\.OTHER describes a D1 binding the wrangler config does not have/);
    expect(() =>
      collectD1Extras(checkout, { DB: { schema: ["missing.sql"] } }, bound, migrations),
    ).toThrow(/the schema file missing\.sql does not exist in the checkout/);
    expect(() =>
      collectD1Extras(checkout, { DB: { postDeployMigrationsDir: "after" } }, bound, migrations),
    ).toThrow(
      /the post-deploy migration 0001_init\.sql of DB has the name of one of its migrations/,
    );
  });

  it("refuses a schema file that links outside the checkout", () => {
    writeFileSync(path.join(root, "outside.sql"), "CREATE TABLE IF NOT EXISTS a (id);");
    symlinkSync(path.join(root, "outside.sql"), path.join(checkout, "schema.sql"));
    expect(() =>
      collectD1Extras(checkout, { DB: { schema: ["schema.sql"] } }, bound, migrations),
    ).toThrow(/the schema file schema\.sql leads outside the checkout/);
  });
});
