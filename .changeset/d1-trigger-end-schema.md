---
"@appflare/schema": minor
---

New `normalizeForD1Query` rewrites SQL so that D1's query API ends each trigger where SQLite does; only whitespace and the case of each trigger's own `BEGIN` and `END` change. New `d1QueryProblems` names what it cannot fix: `END;` inside a string or quoted name in a trigger body. It also names a trigger whose body has no `END` directly after a `;`, which SQLite refuses and which would otherwise hide every statement after it from the checks. `schemaFileProblems` and `baselineFileProblems` now report those too.

`splitSqlStatements`, and with it the schema file and baseline checks, now finds a trigger's body as SQLite does: its `BEGIN` comes after the table the trigger is on, and its `END` directly after a `;`. A column, table or trigger named `end` or `begin` (`NEW.end`, `UPDATE OF begin`) used to end the body early and split the trigger, which refused such a schema file by mistake.
