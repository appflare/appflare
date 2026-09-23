---
"@appflare/manager": minor
---

Appflare can now update itself. Every 30 minutes the manager checks its own
release feed (GitHub Releases tagged `manager@<version>`) and Settings shows
"Update available" with the running and latest versions; admins can also check
on demand. "Update Appflare" verifies the signed release, takes a snapshot of
the running version and a bookmark of the manager's database, uploads the new
version next to the current one with the Worker's own bindings, checks the new
version's preview, and only then switches all traffic to it. The preview check
is the new version's first request, so it migrates the manager's database before
the switch; migrations only add tables and columns, so the previous version keeps
working with the migrated database (and after a rollback). The job page keeps
following the update across the switch and reloads once the new version answers.
While the update runs no other job can start. `/api/health` now also reports
`latestVersion` and `updateAvailable`.

While the appflare/appflare repository is private, the feed needs an optional
`GITHUB_TOKEN` secret that can read its releases; it is sent only to
api.github.com and github.com. `MANAGER_RELEASES_URL` overrides the feed for local
development.
