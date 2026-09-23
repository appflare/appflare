---
"@appflare/manager": patch
---

Apps with many D1 migrations install and update again.

Each D1 migration file used to be its own job step and its own call into a fresh invocation of the manager, and every such call counts against the job's 50 subrequests on Workers Free. An app with 30 migrations next to a dozen resources, its assets and its health check ran out at the 24th file and failed with "Too many subrequests by single Worker invocation". Now one call ensures `d1_migrations`, lists what is applied, reads the next files with one Range request and applies as many as fit its own invocation (30 small files in one call), and the job steps through further calls only when more remain. Each file is still applied the way `wrangler d1 migrations apply --remote` does it, as one query with the row that records it, so a retried step picks up after the last recorded file and never runs one twice. When a statement fails, the job stops at that file and names it in front of Cloudflare's error. A failed update now also names a database as already migrated when some of its new files ran before a later one failed, or when the last file ran but its answer was lost and the retry found nothing left to apply. The job log shows one "D1 <binding>: apply migrations" step per call instead of the separate table, list and per-file steps.
