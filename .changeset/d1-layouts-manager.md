---
"@appflare/manager": minor
---

Apps whose D1 SQL is not a plain migrations folder install and update. After a database's migrations, the install and update jobs run its schema files through a new `applyD1Schema` job unit, in the catalog's order and on every run, recording nothing. Post-deploy migrations are applied once the new version serves all traffic: right after the upload on install, and on update last, after promotion, the queue consumers, the cron triggers and the health check; when they fail, the log says a rollback would keep them. They are recorded in `d1_migrations` like the others, and a failure there leaves the promoted version recorded. A rollback reverts no migration, post-deploy ones included; the update's database snapshot is the way back. Usage data counts failures in these steps as D1 migration failures.

Migrations are applied in wrangler's order (`9_b.sql` before `10_a.sql`), and artifacts of format 3 are read. An artifact in a format newer than this version reads fails with a message to update Appflare instead of a list of schema errors.
