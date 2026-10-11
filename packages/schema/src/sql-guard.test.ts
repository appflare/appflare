import { describe, expect, it } from "vitest";
import {
  baselineFileProblems,
  d1QueryProblems,
  endsInsideStatement,
  normalizeForD1Query,
  schemaFileProblems,
  splitSqlStatements,
} from "./sql-guard";

describe("endsInsideStatement", () => {
  it("reads a closing ; outside comments, strings and trigger bodies", () => {
    expect(endsInsideStatement("CREATE TABLE a (x);")).toBe(false);
    expect(endsInsideStatement("CREATE TABLE a (x);\n-- done; really\n")).toBe(false);
    expect(endsInsideStatement("CREATE TABLE a (x)")).toBe(true);
    expect(endsInsideStatement("CREATE TABLE a (x)\n-- no end;")).toBe(true);
    expect(endsInsideStatement("INSERT INTO a VALUES ('x;')")).toBe(true);
    expect(endsInsideStatement("CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END")).toBe(
      true,
    );
    expect(endsInsideStatement("CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END;")).toBe(
      false,
    );
  });
});

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

  it("reads end and begin as names where SQLite does, keeping each trigger in one statement", () => {
    // Neither word is reserved, so a column, a table or a trigger may take either name.
    const sql = `CREATE TRIGGER IF NOT EXISTS t AFTER INSERT ON events BEGIN
      UPDATE stats SET last = NEW.end;
      UPDATE stats SET n = n + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS begin AFTER UPDATE OF begin, end ON begin
    WHEN EXISTS (SELECT 1 FROM b WHERE begin = NEW.x) begin
      UPDATE b SET end = OLD.end WHERE begin = NEW.x;
      SELECT 1;
    end;
    DROP TABLE b;`;
    expect(splitSqlStatements(sql).map((s) => s.line)).toEqual([1, 5, 10]);
    expect(schemaFileProblems(sql)).toEqual([`line 10: DROP TABLE b drops ${CHANGE_WHY}`]);
  });

  it("refuses a file with no statements", () => {
    expect(schemaFileProblems("-- nothing yet\n")).toEqual(["it has no SQL statements"]);
  });
});

/**
 * Shaped like the schema.sql of apps that keep their whole schema in one file
 * and ALTER migrations for older databases: plain CREATEs, a virtual table
 * with a trigger, and default rows.
 */
const BASELINE = `CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL
);
CREATE INDEX idx_posts_slug ON posts(slug);
CREATE VIRTUAL TABLE posts_fts USING fts5(title, content='posts', content_rowid='id');
CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title) VALUES (new.id, new.title);
END;
PRAGMA defer_foreign_keys = true;
PRAGMA table_info(posts);
INSERT INTO posts (slug, title) VALUES ('hello', 'Hello');
DROP TABLE IF EXISTS legacy;
`;

const TRANSACTION_WHY =
  "controls a transaction; the baseline already runs as one, and D1 refuses its own";

describe("baselineFileProblems", () => {
  it("accepts a whole schema without IF NOT EXISTS, with rows and drops of its own", () => {
    expect(baselineFileProblems(BASELINE)).toEqual([]);
  });

  it("refuses ATTACH, DETACH, DROP DATABASE and PRAGMAs that change a setting, naming the line", () => {
    const sql = `CREATE TABLE a (id INTEGER);
ATTACH DATABASE 'other.db' AS other;
DETACH other;
DROP DATABASE main;
PRAGMA foreign_keys = OFF;
PRAGMA main.journal_mode = WAL;
PRAGMA user_version(3);`;
    const problems = baselineFileProblems(sql);
    expect(problems.map((p) => p.split(":")[0])).toEqual([
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
    ]);
    expect(problems[3]).toContain("PRAGMA foreign_keys changes a database setting");
    expect(problems[4]).toContain("PRAGMA journal_mode changes a database setting");
  });

  it("refuses statements that open or end a transaction, but not a trigger's BEGIN ... END", () => {
    const sql = "BEGIN TRANSACTION;\nCREATE TABLE a (id INTEGER);\nCOMMIT;";
    expect(baselineFileProblems(sql)).toEqual([
      `line 1: BEGIN ${TRANSACTION_WHY}`,
      `line 3: COMMIT ${TRANSACTION_WHY}`,
    ]);
  });

  it("refuses d1_migrations and the sqlite_ and _cf_ tables, quoted or not", () => {
    const problems = baselineFileProblems(
      "CREATE TABLE a (id INTEGER);\n" +
        "INSERT INTO \"d1_migrations\" (name) VALUES ('x');\n" +
        "DELETE FROM _cf_KV;\n" +
        "DELETE FROM sqlite_sequence;",
    );
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^line 2: it names d1_migrations;/);
  });

  it("refuses internal tables named in single quotes too", () => {
    expect(
      baselineFileProblems(
        "CREATE TABLE a (id INTEGER);\nINSERT INTO 'd1_migrations' (name) VALUES ('x');",
      ),
    ).toEqual([
      "line 2: it names d1_migrations; Appflare records the migrations in d1_migrations itself, and the sqlite_ and _cf_ tables belong to SQLite and D1",
    ]);
  });

  it("refuses a file that ends inside an unclosed comment, string or quoted name", () => {
    const base = "CREATE TABLE a (id INTEGER);\n";
    expect(baselineFileProblems(`${base}/* trailing note`)).toEqual([
      "it ends inside a /* comment that is never closed",
    ]);
    expect(baselineFileProblems(`${base}INSERT INTO a VALUES ('it''s`)).toContain(
      "it ends inside a string that is never closed",
    );
    expect(baselineFileProblems(`${base}CREATE TABLE "b (id INTEGER);`)).toContain(
      'it ends inside a name quoted with " that is never closed',
    );
    // Closed ones, and a last line comment, are fine.
    expect(baselineFileProblems(`${base}/* note */ INSERT INTO a VALUES ('x''y'); -- end`)).toEqual(
      [],
    );
  });

  it("refuses a file that creates no table, or only temporary ones, or has no statements", () => {
    expect(baselineFileProblems("CREATE INDEX i ON a(x);")).toEqual([
      "it creates no table; a baseline holds the app's whole schema",
    ]);
    expect(baselineFileProblems("CREATE TEMP TABLE t (x);\nCREATE TEMPORARY TABLE u (x);")).toEqual(
      ["it creates no table; a baseline holds the app's whole schema"],
    );
    expect(baselineFileProblems("-- empty\n")).toEqual(["it has no SQL statements"]);
  });
});

/**
 * Shaped like a schema file whose trigger checks a row with SELECT CASE ...
 * END; and RAISE: D1's query endpoint used to end the trigger at the CASE's
 * END; and refuse the whole file.
 */
const CASE_TRIGGER = `CREATE TABLE IF NOT EXISTS invite_uses (invite_id INTEGER, user_id INTEGER);
CREATE TRIGGER IF NOT EXISTS validate_invite_use
BEFORE INSERT ON invite_uses
BEGIN
  SELECT CASE
    WHEN NEW.user_id IS NULL THEN RAISE(ABORT, 'USER_REQUIRED')
    WHEN NOT EXISTS (SELECT 1 FROM invites WHERE id = NEW.invite_id) THEN RAISE(ABORT, 'UNAVAILABLE')
  END;
END;
CREATE INDEX IF NOT EXISTS idx_invite_uses ON invite_uses(invite_id);
`;

/** The words, strings and punctuation of `sql`, upper-cased: what SQLite reads, whitespace and comments aside. */
function readAs(sql: string): string[][] {
  return splitSqlStatements(sql).map((s) => s.tokens.map((t) => t.value));
}

describe("normalizeForD1Query", () => {
  it("puts a space before the ; of a CASE's END; in a trigger body, and nothing else changes", () => {
    const normalized = normalizeForD1Query(CASE_TRIGGER);
    expect(normalized).toBe(CASE_TRIGGER.replace("  END;\nEND;", "  END ;\nEND;"));
    expect(readAs(normalized)).toEqual(readAs(CASE_TRIGGER));
    expect(normalized.split("\n")).toHaveLength(CASE_TRIGGER.split("\n").length);
  });

  it("fixes each END; D1 would end the body at, wherever it stands in the body", () => {
    const cases: Array<[string, string]> = [
      // The CASE's END; as the last statement, and in a statement before another.
      [
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN NEW.x THEN 1 END; END;",
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN NEW.x THEN 1 END ; END;",
      ],
      [
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN\n  DELETE FROM b WHERE id = CASE WHEN NEW.x THEN 1 ELSE 2 END;\n  SELECT 1;\nEND;",
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN\n  DELETE FROM b WHERE id = CASE WHEN NEW.x THEN 1 ELSE 2 END ;\n  SELECT 1;\nEND;",
      ],
      // A name that ends in END.
      [
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = 1 WHERE id = NEW.WEEKEND; END;",
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = 1 WHERE id = NEW.WEEKEND ; END;",
      ],
      // Comments: a space in a comment changes nothing.
      [
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN\n  -- the END; of it\n  SELECT 1;\nEND;",
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN\n  -- the END ; of it\n  SELECT 1;\nEND;",
      ],
      [
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN /* END; */ SELECT 1; END;",
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN /* END ; */ SELECT 1; END;",
      ],
      // Nested CASEs: only the outer END can meet the ;.
      [
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN NEW.x THEN CASE WHEN NEW.y THEN 1 END END; END;",
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN NEW.x THEN CASE WHEN NEW.y THEN 1 END END ; END;",
      ],
      [
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN NEW.x THEN (CASE NEW.y WHEN 1 THEN 2 END) END; END;",
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN NEW.x THEN (CASE NEW.y WHEN 1 THEN 2 END) END ; END;",
      ],
    ];
    for (const [sql, want] of cases) {
      expect(normalizeForD1Query(sql)).toBe(want);
      expect(readAs(want)).toEqual(readAs(sql));
    }
  });

  it("leaves what D1 already reads correctly as it is", () => {
    const same = [
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN 1 THEN 2 END ; END;",
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN 1 THEN 2 END\n; END;",
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN 1 THEN 2 END\t; END;",
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN 1 THEN 2 end; END;",
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN 1 THEN 2 End; END;",
      "CREATE TRIGGER t AFTER UPDATE ON a BEGIN UPDATE a SET x = CASE WHEN 1 THEN 2 END WHERE id = 1; END;",
      // Outside a trigger D1 reads END; correctly, in code, comments and strings.
      "SELECT CASE WHEN 1 THEN 2 END;\n-- END;\nINSERT INTO a VALUES ('END;');",
      // Before BEGIN D1 does not look for END;.
      "CREATE TRIGGER t AFTER INSERT ON a WHEN NEW.x <> 'END;' BEGIN SELECT 1; END;",
      // A trigger whose text never ends.
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN 1 THEN 2 END",
      "",
    ];
    for (const sql of same) expect(normalizeForD1Query(sql)).toBe(sql);
    expect(normalizeForD1Query(IDEMPOTENT)).toBe(IDEMPOTENT);
    expect(normalizeForD1Query(BASELINE)).toBe(BASELINE);
  });

  it("writes the body's own BEGIN and END in upper case, which is how D1 finds them", () => {
    expect(
      normalizeForD1Query(
        "create trigger if not exists t after insert on a begin select case when 1 then 2 END; end;",
      ),
    ).toBe(
      "create trigger if not exists t after insert on a BEGIN select case when 1 then 2 END ; END;",
    );
    expect(
      normalizeForD1Query("Create Temp Trigger t After Insert On a Begin Select 1; End;"),
    ).toBe("Create Temp Trigger t After Insert On a BEGIN Select 1; END;");
  });

  it("leaves end after a . as the name it is", () => {
    // `end` is not reserved, so it may name a column; D1 does not end a body at `end;`.
    const same = [
      "CREATE TRIGGER t AFTER INSERT ON events BEGIN UPDATE stats SET last = NEW.end; UPDATE stats SET n = n + 1; END;",
      "CREATE TRIGGER t AFTER DELETE ON events BEGIN UPDATE stats SET last = OLD.end WHERE n >= 0; END;",
    ];
    for (const sql of same) expect(normalizeForD1Query(sql)).toBe(sql);
    // The body's END is the one after a `;`, so the scan reaches what follows NEW.end.
    const sql =
      "CREATE TRIGGER t AFTER INSERT ON events BEGIN UPDATE b SET x = NEW.end WHERE y = 2; SELECT CASE WHEN NEW.x THEN 1 END; end;";
    const want =
      "CREATE TRIGGER t AFTER INSERT ON events BEGIN UPDATE b SET x = NEW.end WHERE y = 2; SELECT CASE WHEN NEW.x THEN 1 END ; END;";
    expect(normalizeForD1Query(sql)).toBe(want);
    expect(readAs(want)).toEqual(readAs(sql));
  });

  it("upper-cases the body's BEGIN, not a trigger, table or column named begin", () => {
    const cases: Array<[string, string]> = [
      [
        "create trigger t after update of begin, x on ev begin select 1; select 2; end;",
        "create trigger t after update of begin, x on ev BEGIN select 1; select 2; END;",
      ],
      [
        "create trigger t after insert on begin begin select 1; select 2; end;",
        "create trigger t after insert on begin BEGIN select 1; select 2; END;",
      ],
      [
        "create trigger begin after insert on main.begin for each row when exists (select 1 from b where begin = new.x) begin select 1; select 2; end;",
        "create trigger begin after insert on main.begin for each row when exists (select 1 from b where begin = new.x) BEGIN select 1; select 2; END;",
      ],
    ];
    for (const [sql, want] of cases) {
      expect(normalizeForD1Query(sql)).toBe(want);
      expect(readAs(want)).toEqual(readAs(sql));
    }
  });

  it("fixes every trigger of a file, and is idempotent", () => {
    const sql = [
      "CREATE TABLE IF NOT EXISTS a (x INTEGER, y TEXT);",
      "CREATE TRIGGER IF NOT EXISTS t1 AFTER INSERT ON a BEGIN SELECT CASE WHEN NEW.x < 0 THEN RAISE(ABORT, 'x') END; END;",
      "SELECT CASE WHEN 1 THEN 2 END;",
      "CREATE TRIGGER IF NOT EXISTS t2 AFTER UPDATE ON a BEGIN",
      "  UPDATE a SET y = CASE WHEN NEW.x > 0 THEN 'up' ELSE 'down' END;",
      "  SELECT CASE WHEN NEW.y IS NULL THEN RAISE(ABORT, 'y') END;",
      "END;",
    ].join("\n");
    const normalized = normalizeForD1Query(sql);
    expect(normalized.match(/END ;/g)).toHaveLength(3);
    expect(normalized).toContain("SELECT CASE WHEN 1 THEN 2 END;\n");
    expect(normalized.endsWith("RAISE(ABORT, 'y') END ;\nEND;")).toBe(true);
    expect(normalizeForD1Query(normalized)).toBe(normalized);
    expect(readAs(normalized)).toEqual(readAs(sql));
  });

  it("leaves an END; in a string or quoted name, which d1QueryProblems reports", () => {
    const sql =
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN NEW.x THEN RAISE(ABORT, 'the END; of x') END; END;";
    expect(normalizeForD1Query(sql)).toBe(
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN NEW.x THEN RAISE(ABORT, 'the END; of x') END ; END;",
    );
  });
});

const TRIGGER_END_WHY =
  "D1 ends a trigger's body at the first END; in its text, even there, so the trigger would be cut short and D1 would refuse the file";
const STRING_ADVICE =
  "split the string between END and ; ('END' || ';' is the same value; inside RAISE(), 'END ;' always works)";

describe("d1QueryProblems", () => {
  it("names each string or quoted name in a trigger body that holds END;", () => {
    const sql = `CREATE TABLE IF NOT EXISTS a (x INTEGER);
CREATE TRIGGER IF NOT EXISTS main.guard AFTER INSERT ON a
BEGIN
  SELECT RAISE(ABORT, 'no END; here');
  UPDATE a SET "x END;" = 1;
END;
`;
    expect(d1QueryProblems(sql)).toEqual([
      `line 4: a string in the trigger main.guard holds END;. ${TRIGGER_END_WHY}; ${STRING_ADVICE}`,
      `line 5: the name "x END;" in the trigger main.guard holds END;. ${TRIGGER_END_WHY}; rename it`,
    ]);
  });

  it("reads the whole body, past a column named end", () => {
    expect(
      d1QueryProblems(
        "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET x = NEW.end;\n  SELECT RAISE(ABORT, 'END;');\nEND;",
      ),
    ).toEqual([
      `line 2: a string in the trigger t holds END;. ${TRIGGER_END_WHY}; ${STRING_ADVICE}`,
    ]);
  });

  it("has nothing to say about what normalizeForD1Query fixes, or END; outside a body", () => {
    expect(d1QueryProblems(CASE_TRIGGER)).toEqual([]);
    expect(
      d1QueryProblems(
        "-- END;\nINSERT INTO a VALUES ('END;');\nCREATE TRIGGER t AFTER INSERT ON a WHEN NEW.x <> 'END;' BEGIN SELECT 'end;', 'END'; END;",
      ),
    ).toEqual([]);
  });

  it("is part of the schema file and baseline checks", () => {
    const body = "BEGIN SELECT RAISE(ABORT, 'END;'); END;";
    expect(schemaFileProblems(`CREATE TRIGGER IF NOT EXISTS t AFTER INSERT ON a ${body}`)).toEqual([
      `line 1: a string in the trigger t holds END;. ${TRIGGER_END_WHY}; ${STRING_ADVICE}`,
    ]);
    expect(
      baselineFileProblems(`CREATE TABLE a (x);\nCREATE TRIGGER t AFTER INSERT ON a ${body}`),
    ).toEqual([
      `line 2: a string in the trigger t holds END;. ${TRIGGER_END_WHY}; ${STRING_ADVICE}`,
    ]);
    expect(schemaFileProblems(CASE_TRIGGER)).toEqual([]);
  });

  it("names a trigger whose body never closes, which would hide the statements after it", () => {
    // `SELECT 1 END;` reads END as the column's alias, so trigger a's body runs on to the end.
    const rest = [
      "CREATE TRIGGER IF NOT EXISTS a AFTER INSERT ON x BEGIN SELECT 1 END;",
      "DROP TABLE y;",
      "CREATE TRIGGER IF NOT EXISTS b AFTER INSERT ON x BEGIN END;",
      "DELETE FROM z;",
    ].join("\n");
    const unclosed = (line: number) =>
      `line ${line}: the trigger a has no END directly after a ; to close its body, so SQLite reads the rest of the file as part of the trigger; end the body's last statement with ; and close the body with END`;
    expect(splitSqlStatements(rest)).toHaveLength(1);
    expect(schemaFileProblems(rest)).toEqual([unclosed(1)]);
    expect(baselineFileProblems(`CREATE TABLE x (id);\n${rest}`)).toEqual([unclosed(2)]);
    expect(d1QueryProblems(`CREATE TABLE w (id);\n${rest}`)).toEqual([unclosed(2)]);
    expect(d1QueryProblems("CREATE TRIGGER a AFTER INSERT ON x BEGIN SELECT 1;")).toEqual([
      unclosed(1),
    ]);
  });
});
