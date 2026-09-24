---
"@appflare/schema": minor
---

Catalog index rows may carry `services` (the Cloudflare services the app uses), `categories` (copied from the catalog manifest) and `keyValueDurableObjects` (written only when the app declares key-value backed Durable Objects, which need Workers Paid). All three are optional, so an index published before them still parses, and `services` holds plain strings so a manager keeps reading rows that name services added after its release. Adds `SERVICE_IDS`, `isServiceId()`, `requirementService()`, `deriveServices()` and `appServices()`: the derivation from an artifact's Worker (bindings, queue consumers, crons, Durable Object migrations) and a catalog manifest (`requires`, `install.emailRouting`, Vectorize resources, token permissions), shared by the catalog build and the manager.
