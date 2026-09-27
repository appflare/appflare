/**
 * Checks on the SQL a catalog entry runs against an app's D1 database, shared
 * by the catalog manifest's schema, the packer, catalog CI and the manager.
 *
 * Schema files ({@link schemaFileProblems}) are not recorded in
 * `d1_migrations`, so each runs again against a database that already has
 * everything it creates, and its data. A file passes only when every CREATE
 * TABLE, INDEX, TRIGGER and VIEW says IF NOT EXISTS, no statement drops or
 * alters anything, and no statement changes rows a second run would change
 * again: `UPDATE`, `DELETE`, `REPLACE` (also after `WITH`) and every `INSERT`
 * but `INSERT OR IGNORE` and `INSERT ... ON CONFLICT DO NOTHING` are refused.
 * Seed rows, PRAGMAs and SELECTs pass.
 *
 * Seed statements ({@link seedStatementProblems}) are stricter: one `INSERT`
 * that only adds a missing row, whose values arrive as bound `?` parameters.
 *
 * A baseline ({@link baselineFileProblems}) runs once on a new database, so
 * it need not be safe to run again; it may only keep to the app's own
 * database and leave how D1 runs it alone.
 *
 * The checks read SQLite's syntax only as far as they must: comments are
 * stripped, strings and quoted identifiers are skipped whole, and statements
 * end at `;`, except inside a trigger's `BEGIN ... END` body.
 */

type TokenKind = "word" | "quoted" | "string" | "punct";

interface Token {
  kind: TokenKind;
  /** Upper-cased for words, as written otherwise. */
  value: string;
  /** Source text, for messages. */
  text: string;
}

/** One SQL statement, as the check reads it. */
export interface SqlStatement {
  /** 1-based line the statement starts on. */
  line: number;
  tokens: Token[];
}

const WORD_START = /[A-Za-z_]/;
const WORD_PART = /[A-Za-z0-9_$]/;

/**
 * The end of a quoted run starting at `start`, where a doubled closing quote
 * is part of it; null when the text ends before the run is closed.
 */
function quotedClose(sql: string, start: number, close: string): number | null {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === close) {
      if (close !== "]" && sql[i + 1] === close) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return null;
}

/** The end of a quoted run starting at `start`, or the end of the text when it is never closed. */
function quotedEnd(sql: string, start: number, close: string): number {
  return quotedClose(sql, start, close) ?? sql.length;
}

/**
 * Why `sql` ends inside a block comment, a string or a quoted name that is
 * never closed, or null when it does not. Whatever follows such SQL in the
 * same query (the row that records a migration, the next statement) becomes
 * part of the comment or string, so it would silently not run.
 */
export function unclosedAtEndProblem(sql: string): string | null {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    if (c === "-" && sql[i + 1] === "-") {
      const next = sql.indexOf("\n", i);
      if (next === -1) return null;
      i = next + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      if (close === -1) return "it ends inside a /* comment that is never closed";
      i = close + 2;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const stop = quotedClose(sql, i, c === "[" ? "]" : c);
      if (stop === null) {
        return c === "'"
          ? "it ends inside a string that is never closed"
          : `it ends inside a name quoted with ${c} that is never closed`;
      }
      i = stop;
    } else {
      i += 1;
    }
  }
  return null;
}

/**
 * Splits SQL into statements with comments removed. A statement that is only
 * `;` (or comments) is dropped.
 */
export function splitSqlStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let tokens: Token[] = [];
  let startLine = 1;
  let line = 1;
  // Inside a CREATE TRIGGER's body: BEGIN opens it, CASE ... END nests.
  let depth = 0;
  let sawBegin = false;
  // The statement's first three words, which say whether it creates a trigger.
  let head: string[] = [];

  const isTrigger = () => {
    if (head[0] !== "CREATE") return false;
    const kind = head[1] === "TEMP" || head[1] === "TEMPORARY" ? head[2] : head[1];
    return kind === "TRIGGER";
  };
  const push = (token: Token) => {
    if (tokens.length === 0) startLine = line;
    tokens.push(token);
    if (token.kind !== "word") return;
    if (head.length < 3) head.push(token.value);
    if (!isTrigger()) return;
    if (token.value === "BEGIN" && !sawBegin) {
      sawBegin = true;
      depth = 1;
    } else if (sawBegin && token.value === "CASE") {
      depth += 1;
    } else if (sawBegin && token.value === "END" && depth > 0) {
      depth -= 1;
    }
  };
  const end = () => {
    if (tokens.length > 0) statements.push({ line: startLine, tokens });
    tokens = [];
    head = [];
    depth = 0;
    sawBegin = false;
  };

  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    if (c === "\n") {
      line += 1;
      i += 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const next = sql.indexOf("\n", i);
      i = next === -1 ? sql.length : next;
    } else if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      const stop = close === -1 ? sql.length : close + 2;
      line += (sql.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const stop = quotedEnd(sql, i, c === "[" ? "]" : c);
      const text = sql.slice(i, stop);
      push({ kind: c === "'" ? "string" : "quoted", value: text, text });
      line += (text.match(/\n/g) ?? []).length;
      i = stop;
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < sql.length && WORD_PART.test(sql[j] as string)) j += 1;
      const text = sql.slice(i, j);
      push({ kind: "word", value: text.toUpperCase(), text });
      i = j;
    } else if (c === "?") {
      // A parameter: `?` alone, or numbered (`?1`), kept as one token.
      let j = i + 1;
      while (j < sql.length && /[0-9]/.test(sql[j] as string)) j += 1;
      const text = sql.slice(i, j);
      push({ kind: "punct", value: text, text });
      i = j;
    } else if (c === ";") {
      if (depth === 0) end();
      else push({ kind: "punct", value: c, text: c });
      i += 1;
    } else if (/\s/.test(c)) {
      i += 1;
    } else {
      push({ kind: "punct", value: c, text: c });
      i += 1;
    }
  }
  end();
  return statements;
}

const CREATED_KINDS = new Set(["TABLE", "INDEX", "TRIGGER", "VIEW"]);
const CREATE_MODIFIERS = new Set(["TEMP", "TEMPORARY", "UNIQUE", "VIRTUAL"]);

function isWord(token: Token | undefined, value: string): boolean {
  return token?.kind === "word" && token.value === value;
}

const DATA_VERBS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "REPLACE"]);

/**
 * The verb of a data statement: its first word, or for `WITH ...` the first
 * data verb outside the parentheses of its common table expressions.
 */
function dataVerb(tokens: readonly Token[]): { verb: string; at: number } | null {
  const first = tokens[0];
  if (first?.kind !== "word") return null;
  if (first.value !== "WITH") {
    return DATA_VERBS.has(first.value) ? { verb: first.value, at: 0 } : null;
  }
  let depth = 0;
  for (const [i, token] of tokens.entries()) {
    if (token.kind === "punct" && token.value === "(") depth += 1;
    else if (token.kind === "punct" && token.value === ")") depth -= 1;
    else if (depth === 0 && token.kind === "word" && DATA_VERBS.has(token.value)) {
      return { verb: token.value, at: i };
    }
  }
  return null;
}

/** Whether `words` has `a` directly followed by `b`. */
function hasPair(tokens: readonly Token[], a: string, b: string): boolean {
  return tokens.some((t, i) => isWord(t, a) && isWord(tokens[i + 1], b));
}

/**
 * Why a data statement would change rows a second time, or null when running
 * it again changes nothing: only `INSERT OR IGNORE` and an `INSERT` whose
 * every `ON CONFLICT` does nothing may write, so seed rows stay seed rows.
 */
function dataWriteProblem(tokens: readonly Token[]): string | null {
  const found = dataVerb(tokens);
  if (found === null || found.verb === "SELECT") return null;
  const why =
    "a schema file runs on every install and update, so it may only add rows that are missing (INSERT OR IGNORE, or ON CONFLICT DO NOTHING)";
  if (found.verb !== "INSERT") return `${found.verb} changes rows on every run; ${why}`;
  const rest = tokens.slice(found.at);
  if (hasPair(rest, "DO", "UPDATE")) {
    return `INSERT ... ON CONFLICT DO UPDATE changes rows on every run; ${why}`;
  }
  if (isWord(rest[1], "OR")) {
    const resolution = rest[2]?.value ?? "";
    if (resolution === "IGNORE") return null;
    return `INSERT OR ${resolution} changes rows on every run; ${why}`;
  }
  if (hasPair(rest, "ON", "CONFLICT") && hasPair(rest, "DO", "NOTHING")) return null;
  return `INSERT without OR IGNORE or ON CONFLICT DO NOTHING fails or duplicates rows on the next run; ${why}`;
}

/** Why one statement may not run on every install and update, or null when it may. */
function statementProblem(statement: SqlStatement): string | null {
  const { tokens } = statement;
  const first = tokens[0];
  const at = `line ${statement.line}`;
  if (isWord(first, "DROP") || isWord(first, "ALTER")) {
    const what = tokens
      .slice(0, 3)
      .map((t) => t.text)
      .join(" ");
    return `${at}: ${what} ${first?.value === "DROP" ? "drops" : "alters"} part of the schema; a schema file runs on every install and update, so it may only create what is missing`;
  }
  const write = dataWriteProblem(tokens);
  if (write !== null) return `${at}: ${write}`;
  if (!isWord(first, "CREATE")) return null;
  let i = 1;
  while (tokens[i]?.kind === "word" && CREATE_MODIFIERS.has(tokens[i]?.value ?? "")) i += 1;
  const kind = tokens[i];
  if (kind?.kind !== "word" || !CREATED_KINDS.has(kind.value)) return null;
  if (
    isWord(tokens[i + 1], "IF") &&
    isWord(tokens[i + 2], "NOT") &&
    isWord(tokens[i + 3], "EXISTS")
  ) {
    return null;
  }
  const name = tokens[i + 1]?.text ?? "";
  return `${at}: CREATE ${kind.value} ${name} has no IF NOT EXISTS; a schema file runs on every install and update, so each CREATE must skip what already exists`;
}

/**
 * Why `sql` may not be a schema file, as sentences naming the line of each
 * statement at fault; empty when it may.
 */
export function schemaFileProblems(sql: string): string[] {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) return ["it has no SQL statements"];
  return statements.map(statementProblem).filter((p): p is string => p !== null);
}

/**
 * PRAGMAs a baseline may call with an argument in parentheses: they only
 * read. Any other PRAGMA with an argument, and every `PRAGMA name = value`,
 * changes how the database behaves and is refused.
 */
const READ_ONLY_PRAGMAS = new Set([
  "TABLE_INFO",
  "TABLE_XINFO",
  "TABLE_LIST",
  "INDEX_INFO",
  "INDEX_XINFO",
  "INDEX_LIST",
  "FOREIGN_KEY_LIST",
  "FOREIGN_KEY_CHECK",
  "INTEGRITY_CHECK",
  "QUICK_CHECK",
]);

/** Statement kinds a baseline may not start with: D1 runs the file as one transaction. */
const TRANSACTION_WORDS = new Set(["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"]);

/** Why one baseline statement may not run, or null when it may. */
function baselineStatementProblem(statement: SqlStatement): string | null {
  const { tokens } = statement;
  const first = tokens[0];
  const at = `line ${statement.line}`;
  if (isWord(first, "ATTACH") || isWord(first, "DETACH")) {
    return `${at}: ${first?.value} reaches another database; a baseline builds only the app's own`;
  }
  if (isWord(first, "DROP") && isWord(tokens[1], "DATABASE")) {
    return `${at}: DROP DATABASE is not something a baseline may run`;
  }
  if (first?.kind === "word" && TRANSACTION_WORDS.has(first.value)) {
    return `${at}: ${first.value} controls a transaction; the baseline already runs as one, and D1 refuses its own`;
  }
  if (isWord(first, "PRAGMA")) {
    // `PRAGMA [schema.]name`, then `= value`, `(argument)` or nothing.
    const dotted = tokens[2]?.kind === "punct" && tokens[2].value === ".";
    const name = tokens[dotted ? 3 : 1];
    const next = tokens[dotted ? 4 : 2];
    const sets = next?.kind === "punct" && next.value === "=";
    const called = next?.kind === "punct" && next.value === "(";
    const pragma = name?.value.toUpperCase() ?? "";
    // defer_foreign_keys lasts until the transaction ends, the way D1
    // suggests loading rows whose references come later in the file.
    if (pragma !== "DEFER_FOREIGN_KEYS" && (sets || (called && !READ_ONLY_PRAGMAS.has(pragma)))) {
      return `${at}: PRAGMA ${name?.text ?? ""} changes a database setting; a baseline may only create the schema and its rows`;
    }
  }
  const internal = internalTableNames(tokens);
  if (internal.length > 0) {
    return `${at}: it names ${internal.join(", ")}; Appflare records the migrations in d1_migrations itself, and the sqlite_ and _cf_ tables belong to SQLite and D1`;
  }
  return null;
}

/**
 * Whether a statement creates a table that outlives the query (plain or
 * virtual). A temporary table is gone once the query ends, so it does not
 * count.
 */
function createsTable(statement: SqlStatement): boolean {
  const { tokens } = statement;
  if (!isWord(tokens[0], "CREATE")) return false;
  let i = 1;
  let temporary = false;
  while (tokens[i]?.kind === "word" && CREATE_MODIFIERS.has(tokens[i]?.value ?? "")) {
    if (isWord(tokens[i], "TEMP") || isWord(tokens[i], "TEMPORARY")) temporary = true;
    i += 1;
  }
  return !temporary && isWord(tokens[i], "TABLE");
}

/**
 * Why `sql` may not be a D1 baseline, as sentences naming the line of each
 * statement at fault; empty when it may.
 *
 * A baseline runs once, at install, on the database the install has just
 * created, as one D1 query (all of it applies or none of it does), and every
 * migration the version ships is recorded as applied in the same query. So
 * it may create without IF NOT EXISTS, insert rows, and drop or alter what it
 * made itself. It may not reach past the app's database or change how D1
 * runs it: no ATTACH, DETACH or DROP DATABASE, no PRAGMA that sets a value
 * (but `defer_foreign_keys`, which ends with the transaction), no statement
 * that opens or ends a transaction, and no mention of `d1_migrations` or a
 * `sqlite_` or `_cf_` table, even in a string. It must create at least one
 * table (a temporary one does not count), which is also how a retried step
 * sees that the baseline already ran, and it may not end inside an unclosed
 * comment or string, which would swallow the rows that record the
 * migrations.
 */
export function baselineFileProblems(sql: string): string[] {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) return ["it has no SQL statements"];
  const problems = statements.map(baselineStatementProblem).filter((p): p is string => p !== null);
  const unclosed = unclosedAtEndProblem(sql);
  if (unclosed !== null) problems.push(unclosed);
  if (!statements.some(createsTable)) {
    problems.push("it creates no table; a baseline holds the app's whole schema");
  }
  return problems;
}

/**
 * Whether `sql` ends inside a statement: its last statement has no closing
 * `;` (comments after it aside). Text appended after such SQL would run into
 * that statement, and a `;` appended after SQL that is already closed would
 * be an empty statement, which D1 refuses ("SQL code did not contain a
 * statement"). Read with the statement splitter, so a `;` in a comment, a
 * string or a trigger body does not count.
 */
export function endsInsideStatement(sql: string): boolean {
  // A closed file gains a statement from the probe; an open one absorbs it.
  const probe = `${sql}\nSELECT 1`;
  return splitSqlStatements(probe).length === splitSqlStatements(sql).length;
}

/** Most statements one D1 binding's seed runs. */
export const MAX_SEED_STATEMENTS = 10;
/** Most parameters one seed statement binds. */
export const MAX_SEED_PARAMS = 20;
/** Longest seed statement, in characters. */
export const MAX_SEED_SQL_LENGTH = 4096;

/**
 * Words a seed statement may not hold outside strings and quoted names: every
 * statement kind but INSERT, and what would reach past the one row it adds.
 */
const SEED_BANNED_WORDS = new Set([
  "WITH",
  "CREATE",
  "DROP",
  "ALTER",
  "PRAGMA",
  "ATTACH",
  "DETACH",
  "VACUUM",
  "REINDEX",
  "ANALYZE",
  "UPDATE",
  "DELETE",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);

/** Whether `name` is a table a seed may not touch: D1's own, or SQLite's. */
function isInternalTable(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "d1_migrations" || lower.startsWith("sqlite_") || lower.startsWith("_cf_");
}

/** A quoted name or string without its quotes (doubled quotes undone); a word as written. */
function unquoted(token: Token): string {
  if (token.kind !== "quoted" && token.kind !== "string") return token.text;
  const open = token.text[0] ?? "";
  const close = open === "[" ? "]" : open;
  const inner = token.text.slice(1, token.text.endsWith(close) ? -1 : undefined);
  return open === "[" ? inner : inner.split(`${close}${close}`).join(close);
}

/**
 * The internal tables `tokens` name, as words, quoted names or strings:
 * SQLite reads a single-quoted string as a table name where a name belongs
 * (`INSERT INTO 'd1_migrations' ...`), so strings count too.
 */
function internalTableNames(tokens: readonly Token[]): string[] {
  return [
    ...new Set(
      tokens
        .filter((t) => t.kind === "word" || t.kind === "quoted" || t.kind === "string")
        .map(unquoted)
        .filter(isInternalTable),
    ),
  ];
}

/**
 * Why `sql` cannot be a seed statement with `paramCount` parameters, as
 * sentences; empty when it can. A seed runs once, at install, with values
 * from the install form (a user name, a password hash), so it must:
 *
 * - be exactly one statement;
 * - be an `INSERT OR IGNORE` or an `INSERT ... ON CONFLICT ... DO NOTHING`,
 *   so running it again (a retried step) keeps the row the first run added;
 * - hold no `WITH`, no `DO UPDATE` and no other statement kind (`CREATE`,
 *   `DROP`, `ALTER`, `UPDATE`, `DELETE`, `PRAGMA`, `ATTACH` and the like);
 * - name neither `d1_migrations` nor a `sqlite_` or `_cf_` table, even in a
 *   string, and not end inside an unclosed comment or string;
 * - take its values only as anonymous `?` parameters, exactly as many as it
 *   declares params: no `?1`, `:name`, `@name` or `$name`.
 *
 * Values never become part of the SQL: the statement is signed as written,
 * and D1 binds the values.
 */
export function seedStatementProblems(sql: string, paramCount: number): string[] {
  if (sql.length > MAX_SEED_SQL_LENGTH) {
    return [`it is longer than ${MAX_SEED_SQL_LENGTH} characters`];
  }
  const statements = splitSqlStatements(sql);
  const only = statements[0];
  if (only === undefined) return ["it has no SQL statement"];
  if (statements.length > 1) {
    return [
      `it holds ${statements.length} statements; a seed statement is exactly one INSERT, so list each as a statement of its own`,
    ];
  }
  const { tokens } = only;
  const problems: string[] = [];
  const first = tokens[0];
  const why =
    "a seed only adds a row that is missing (INSERT OR IGNORE, or ON CONFLICT DO NOTHING)";
  if (!isWord(first, "INSERT")) {
    problems.push(`it starts with ${first?.text ?? "nothing"}; ${why}`);
  } else if (isWord(tokens[1], "OR")) {
    const resolution = tokens[2]?.value ?? "";
    if (resolution !== "IGNORE") {
      problems.push(`INSERT OR ${resolution} changes a row that is already there; ${why}`);
    }
  } else if (!(hasPair(tokens, "ON", "CONFLICT") && hasPair(tokens, "DO", "NOTHING"))) {
    problems.push(
      `an INSERT without OR IGNORE or ON CONFLICT DO NOTHING fails or adds a second row when it runs again; ${why}`,
    );
  }
  const doUpdate = hasPair(tokens, "DO", "UPDATE");
  if (doUpdate) {
    problems.push(`ON CONFLICT DO UPDATE changes a row that is already there; ${why}`);
  }
  const banned = [
    ...new Set(
      tokens
        .filter((t) => t.kind === "word" && SEED_BANNED_WORDS.has(t.value))
        .map((t) => t.value)
        .filter((w) => !(w === "UPDATE" && doUpdate)),
    ),
  ];
  if (banned.length > 0) {
    problems.push(`it uses ${banned.join(", ")}; a seed statement is one INSERT and nothing else`);
  }
  const unclosed = unclosedAtEndProblem(sql);
  if (unclosed !== null) problems.push(unclosed);
  const internal = internalTableNames(tokens);
  if (internal.length > 0) {
    problems.push(
      `it names ${internal.join(", ")}; a seed may not touch d1_migrations or the sqlite_ and _cf_ tables`,
    );
  }
  const numbered = tokens.some((t) => t.kind === "punct" && /^\?[0-9]+$/.test(t.value));
  const named = tokens.some((t) => t.kind === "punct" && [":", "@", "$"].includes(t.value));
  if (numbered || named) {
    problems.push(
      "it uses numbered or named parameters; a seed statement takes anonymous ? parameters, bound in the order of its params",
    );
  }
  const placeholders = tokens.filter((t) => t.kind === "punct" && t.value === "?").length;
  if (placeholders !== paramCount) {
    problems.push(
      `it has ${placeholders} ? placeholder(s) and ${paramCount} param(s); give one param per ?, in order`,
    );
  }
  return problems;
}
