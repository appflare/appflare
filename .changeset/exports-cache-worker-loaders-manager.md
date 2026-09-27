---
"@appflare/manager": minor
---

Installs and updates send an app's `exports` and `cache_options` with every script and version upload, as wrangler does, and bind a Worker Loader as recorded. An app whose `exports` declare Durable Objects gets no migrations, since those exports replace them, and no migration tag is recorded for it, so a later version without such exports still sends its migrations. An update whose Durable Object exports differ from the serving version's deploys the whole Worker at once, without a preview check, the way an update with Durable Object migrations does, and warns that the change cannot be undone; a change to entrypoint exports alone is a version upload. A rollback across a change to the Durable Objects the exports declare is refused, as one across migrations is. Apps built from a repository may now use `exports`, `cache` and Worker Loader.

Not yet verified against Cloudflare: moving a Worker from `new_sqlite_classes` migrations to Durable Object exports, and Cloudflare's own refusal of a rollback across a change of exports. Both follow wrangler's behaviour and the handling of migrations.
