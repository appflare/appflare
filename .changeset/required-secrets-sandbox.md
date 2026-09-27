---
"@appflare/sandbox-worker": patch
---

A build from a repository asks for every secret the wrangler config lists in `secrets.required` as well as those `.dev.vars.example` lists, never as optional, and the log says where they came from. A config whose only `unsafe` bindings are rate limits is no longer refused. The image checks that corepack runs, which yarn 2 and later install through, and caches npm 11 for checkouts that ask for it.
