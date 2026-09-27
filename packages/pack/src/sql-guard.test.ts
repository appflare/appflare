import { describe, expect, it } from "vitest";
import { schemaFileProblems, splitSqlStatements } from "./sql-guard.ts";

/**
 * Shaped like the schema files of apps that keep one idempotent schema.sql:
 * comments in several languages, quotes and semicolons inside comments and
 * defaults, indexes after tables, a trigger, seed rows and a PRAGMA.
 */
const IDEMPOTENT = `-- App D1 schema
-- Run: wrangler d1 execute app-db --file=src/db/schema.sql

-- 連結主表 ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT    NOT NULL UNIQUE,           -- 短碼，例如 spring
  password_hash TEXT    DEFAULT '',                -- sha256(slug + ':' + 密碼)；空＝不設密碼
  subject       TEXT    DEFAULT '(no subject; none)',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

/* A block comment; it says DROP TABLE links; and CREATE TABLE x (y); */
CREATE INDEX IF NOT EXISTS idx_links_slug ON links(slug);
create unique index if not exists idx_links_created on links (created_at desc);

-- What is watched. Rows are seeded by the operator: a monitor's URL is often
-- somebody's hostname, so don't commit it.
CREATE TABLE IF NOT EXISTS "monitors" (id INTEGER PRIMARY KEY, "drop" TEXT, [alter] TEXT);
CREATE VIEW IF NOT EXISTS active_links AS SELECT * FROM links WHERE slug <> 'drop table';
CREATE TEMP TABLE IF NOT EXISTS scratch (id INTEGER);
CREATE VIRTUAL TABLE IF NOT EXISTS links_fts USING fts5(slug);
CREATE TRIGGER IF NOT EXISTS links_touch AFTER UPDATE ON links
BEGIN
  UPDATE links SET created_at = CASE WHEN NEW.slug = 'x' THEN 'y' ELSE created_at END WHERE id = NEW.id;
  INSERT INTO monitors (id) VALUES (NEW.id);
END;
INSERT OR IGNORE INTO monitors (id, "drop") VALUES (1, 'it''s; fine');
PRAGMA foreign_keys = ON;
`;

const CREATE_WHY =
  "has no IF NOT EXISTS; a schema file runs on every install and update, so each CREATE must skip what already exists";
const CHANGE_WHY =
  "part of the schema; a schema file runs on every install and update, so it may only create what is missing";

describe("splitSqlStatements", () => {
  it("splits at semicolons outside comments, strings, and trigger bodies", () => {
    const statements = splitSqlStatements(IDEMPOTENT);
    expect(
      statements.map((s) =>
        s.tokens
          .slice(0, 2)
          .map((t) => t.value)
          .join(" "),
      ),
    ).toEqual([
      "CREATE TABLE",
      "CREATE INDEX",
      "CREATE UNIQUE",
      "CREATE TABLE",
      "CREATE VIEW",
      "CREATE TEMP",
      "CREATE VIRTUAL",
      "CREATE TRIGGER",
      "INSERT OR",
      "PRAGMA FOREIGN_KEYS",
    ]);
    expect(statements.map((s) => s.line)).toEqual([5, 14, 15, 19, 20, 21, 22, 23, 28, 29]);
  });

  it("drops empty statements and comment-only text", () => {
    expect(splitSqlStatements(";;\n-- nothing here;\n/* nor; here */ ;")).toEqual([]);
  });
});

describe("schemaFileProblems", () => {
  it("accepts a file whose every CREATE says IF NOT EXISTS and that drops and alters nothing", () => {
    expect(schemaFileProblems(IDEMPOTENT)).toEqual([]);
  });

  it("refuses each CREATE without IF NOT EXISTS, naming its line", () => {
    const sql = [
      "CREATE TABLE IF NOT EXISTS ok (id INTEGER);",
      "CREATE TABLE users (id INTEGER);",
      "CREATE UNIQUE INDEX idx_users ON users(id);",
      "CREATE TEMPORARY VIEW v AS SELECT 1;",
      "CREATE TRIGGER t AFTER INSERT ON users BEGIN SELECT 1; END;",
      'CREATE TABLE "quoted" (id INTEGER); -- IF NOT EXISTS',
    ].join("\n");
    expect(schemaFileProblems(sql)).toEqual([
      `line 2: CREATE TABLE users ${CREATE_WHY}`,
      `line 3: CREATE INDEX idx_users ${CREATE_WHY}`,
      `line 4: CREATE VIEW v ${CREATE_WHY}`,
      `line 5: CREATE TRIGGER t ${CREATE_WHY}`,
      `line 6: CREATE TABLE "quoted" ${CREATE_WHY}`,
    ]);
  });

  it("refuses DROP and ALTER, even guarded ones", () => {
    const sql = [
      "CREATE TABLE IF NOT EXISTS t (id INTEGER);",
      "DROP TABLE IF EXISTS old;",
      "  alter table t add column name TEXT;",
      "/* reset */ DROP INDEX idx_t;",
    ].join("\n");
    expect(schemaFileProblems(sql)).toEqual([
      `line 2: DROP TABLE IF drops ${CHANGE_WHY}`,
      `line 3: alter table t alters ${CHANGE_WHY}`,
      `line 4: DROP INDEX idx_t drops ${CHANGE_WHY}`,
    ]);
  });

  it("refuses statements that change rows again on every run", () => {
    const refused = [
      ["UPDATE settings SET v = 1;", "UPDATE changes rows"],
      ["DELETE FROM sessions;", "DELETE changes rows"],
      ["REPLACE INTO settings (k, v) VALUES ('a', 1);", "REPLACE changes rows"],
      ["INSERT OR REPLACE INTO settings (k) VALUES ('a');", "INSERT OR REPLACE changes rows"],
      ["INSERT INTO settings (k) VALUES ('a');", "INSERT without OR IGNORE"],
      ["INSERT OR ABORT INTO settings (k) VALUES ('a');", "INSERT OR ABORT changes rows"],
      [
        "INSERT INTO settings (k, v) VALUES ('a', 1) ON CONFLICT (k) DO UPDATE SET v = 1;",
        "INSERT ... ON CONFLICT DO UPDATE",
      ],
      [
        "WITH old AS (SELECT id FROM sessions) DELETE FROM sessions WHERE id IN old;",
        "DELETE changes rows",
      ],
      ["WITH x(v) AS (SELECT 1) UPDATE settings SET v = (SELECT v FROM x);", "UPDATE changes"],
    ];
    for (const [sql, message] of refused) {
      const problems = schemaFileProblems(sql as string);
      expect(problems, sql).toHaveLength(1);
      expect(problems[0], sql).toContain(`line 1: ${message}`);
      expect(problems[0], sql).toContain("INSERT OR IGNORE, or ON CONFLICT DO NOTHING");
    }
  });

  it("accepts seed rows that are skipped when present, SELECTs and PRAGMAs", () => {
    expect(
      schemaFileProblems(
        [
          "INSERT OR IGNORE INTO settings (k, v) VALUES ('theme', 'light');",
          "INSERT INTO settings (k, v) VALUES ('a', 1) ON CONFLICT (k) DO NOTHING;",
          "INSERT INTO settings (k) VALUES ('b') ON CONFLICT DO NOTHING;",
          "WITH seed(k) AS (SELECT 'c') INSERT OR IGNORE INTO settings (k) SELECT k FROM seed;",
          "SELECT 1;",
          "PRAGMA foreign_keys = ON;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("is not fooled by IF NOT EXISTS in a comment or a string", () => {
    expect(schemaFileProblems("CREATE TABLE /* IF NOT EXISTS */ t (id INTEGER);")).toHaveLength(1);
    expect(schemaFileProblems("CREATE TABLE 'IF NOT EXISTS' (id INTEGER);")).toHaveLength(1);
    expect(schemaFileProblems("CREATE TABLE IF /* x */ NOT -- y\n EXISTS t (id INTEGER);")).toEqual(
      [],
    );
  });

  it("keeps a trigger body with nested CASE ... END in one statement", () => {
    const sql = `CREATE TRIGGER IF NOT EXISTS t AFTER INSERT ON a BEGIN
      UPDATE a SET x = CASE WHEN 1 THEN CASE WHEN 2 THEN 3 END ELSE 4 END;
      DELETE FROM b;
    END;
    DROP TABLE b;`;
    expect(splitSqlStatements(sql)).toHaveLength(2);
    expect(schemaFileProblems(sql)).toEqual([`line 5: DROP TABLE b drops ${CHANGE_WHY}`]);
  });

  it("refuses a file with no statements", () => {
    expect(schemaFileProblems("-- nothing yet\n")).toEqual(["it has no SQL statements"]);
  });
});
