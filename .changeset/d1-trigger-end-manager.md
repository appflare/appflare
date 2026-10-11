---
"@appflare/manager": patch
---

EdgeChat, and any app whose D1 SQL has a trigger with `CASE ... END;` in its body, now installs and updates. D1's query API ended such a trigger at that `END;` and refused the whole file with "incomplete input". The manager now sends the SQL with a space before that `;`, and with each trigger's own `BEGIN` and `END` in upper case, which D1 needs to find the body. SQLite reads it exactly as before, and each file is still checked against its published digest first.
