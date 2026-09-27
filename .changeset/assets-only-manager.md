---
"@appflare/manager": minor
---

Apps whose Worker serves static assets only install and update. Such a Worker comes in an artifact of format 5, and is uploaded as wrangler uploads one: a multipart request with only its metadata, `assets: { jwt, config }`, `compatibility_date`, `compatibility_flags` and, for a version, `annotations`, with no module parts and no `main_module`. The `uploadWorker` job unit accepts an empty module list and then sends exactly that shape, leaving out the empty binding list and `keep_bindings` that updates add; it refuses such an upload when it carries bindings, Durable Object migrations or exports, a main module, or no assets. Canary, promotion, rollback and the health check work as for any app.
