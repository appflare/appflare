---
"@appflare/schema": minor
---

Catalog entries whose repository ships no wrangler config may carry one in `install.wranglerConfigInline` (and `install.workers[].wranglerConfigInline`), signed with the rest of the manifest. `wranglerConfig` then names where the packer writes it: `.appflare.wrangler.jsonc`, at the root or in a directory of the repository. The config is allowlisted (`wranglerConfigInlineSchema`, `WRANGLER_CONFIG_INLINE_KEYS`): `main`, `compatibility_date` (required), `compatibility_flags`, `assets`, `vars`, `triggers`, `observability`, `placement`, storage bindings without ids, queues, SQLite Durable Object `migrations` and `durable_objects` bindings to the classes they create, Workflow and service bindings without a `script_name`, and the `ai`, `browser`, `images` and `version_metadata` bindings. It is refused beside a config patch or `install.workers`, and on a self-deploying entry. `SANDBOX_FEATURE_WRANGLER_CONFIG_INLINE` names the sandbox Worker feature that writes it.

`UNSUPPORTED_WRANGLER_SECTIONS` now lists every wrangler 4.136.2 config section the packer does not carry into the artifact (Workers VPC, AI Search, Agent Memory, Media, Stream, Artifacts, Flagship, streaming Tail Workers, log forwarding, raw TCP sockets, inbound email `addresses`, Workers Sites and Pages among them), with the words for each in `UNSUPPORTED_WRANGLER_SECTION_LABELS`. A config patch may set any of them to `null` to drop the section from an app that works without it.

A config patch may also leave out a storage `id`, `bucket_name` or `database_id` that is a placeholder an upstream deploy script fills (`$NAME`, `${NAME}`, `{{NAME}}`, `<NAME>`), as it already could an empty one (`isClearableStorageId()`).

A config patch may add `ratelimits` entries, keeping every rate limit of the config as it is, for a limit an upstream deploy script adds to the committed config.
