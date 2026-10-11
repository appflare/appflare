---
"@appflare/pack": minor
---

The packer and `verify` refuse D1 SQL with `END;` inside a string or quoted name in a trigger body, in migrations, post-deploy migrations, schema files and baselines. D1's query API would end the trigger there and refuse the file at install. The message names the line and how to rewrite it.
