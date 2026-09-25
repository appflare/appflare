---
"@appflare/pack": minor
---

Add `appflare-pack inspect <checkoutDir> --config <wrangler config>`: reads a project's wrangler config with wrangler's own reader (JSON, JSONC or TOML, following a redirect a build left) and prints its Worker name, the names of its plain vars, and the sections the packer does not carry into an artifact (`containers`, `dispatch_namespaces`, `tail_consumers`, `pipelines`, `secrets_store_secrets`, `unsafe`, and service-worker module globals), as one JSON line. The sandbox Worker uses it to check a repository before building it. `parseJsonc` now comes from `@appflare/schema`.
