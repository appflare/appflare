---
"@appflare/sandbox-worker": minor
---

A repository whose root has no `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` but keeps one as a template (`wrangler.toml.example`, `wrangler.jsonc.template`, and so on) can be built from the Catalog page: the build detects the template, and the packer copies it to its real name before wrangler reads it. A real config still wins over any template.
