---
"@appflare/cf-api": minor
---

A `hyperdrive` namespace for Hyperdrive configurations: `createConfig` (`POST /accounts/{id}/hyperdrive/configs` with `{ name, origin: { scheme, host, port, database, user, password }, caching? }`, the body Cloudflare's API schema gives for a database reachable on the public internet), `listConfigs` (every page, by `total_count`), `getConfig` and `deleteConfig`. Request bodies carry the database password and, like every body, never appear in an error message or a request log.
