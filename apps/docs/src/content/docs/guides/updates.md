---
title: Update and roll back
description: Updating an app, rolling it back, and restoring a database to an earlier point.
---

## When an update is available

When the catalog has a newer version of an app than the one installed, **Installed
apps** shows **Update available**, and the app's page shows **Update available to
&lt;version&gt;**. The manager compares versions every time you load the page, against the
catalog it refreshes every 30 minutes. It only offers the catalog's current version.

## Update an app

Admins select **Update**. A dialog opens first when:

- the new version needs secrets the install does not have yet. Fill them in; the job
  sets them before the new version serves traffic.
- the app defines Durable Objects, so the new version cannot be checked before it
  goes live. This covers every update of such an app, and it matters most when the
  new version changes its Durable Object classes (see
  [Apps with Durable Objects](#apps-with-durable-objects) below). The dialog says
  which case applies. You confirm with **Update without checking the new version
  first**.

The update job:

1. Fetches and verifies the new version's signed manifest.
2. Takes a snapshot: the Worker version serving traffic now, and a D1 Time Travel
   bookmark for each of the app's databases. It refuses to start while a gradual
   deployment is in progress.
3. Creates resources for bindings the new version adds. An update never deletes a
   resource.
4. Uploads the new assets and the new Worker version, keeping the existing secrets.
   The current version keeps serving.
5. Checks the new version at its preview URL before any traffic reaches it. A
   server error, or a health path that reports a different version, fails the job
   here and nothing changes.
6. Applies new D1 migrations.
7. Switches all traffic to the new version.
8. Runs a [health check](/guides/health/) and records the result.

The current version keeps serving until the new one has passed its checks. If the
job fails before step 7, the app is unchanged, except for new resources and any D1
migrations already applied.

### Apps with Durable Objects

Cloudflare gives no preview URL to a Worker that defines Durable Objects, so updates
of such apps skip step 5. When a new version also changes its Durable Object classes
(a migration), Cloudflare applies that only when the whole Worker is deployed at
once. The job then deploys directly, and the change to the classes cannot be undone
with a rollback.

## Roll back

Each update adds a row under **Versions** on the app's page: when the snapshot was
taken, the catalog version, and the Worker version. Select **Roll back** on a row to
deploy that Worker version again to all traffic. A rollback runs as a job and ends
with a health check.

A rollback changes the Worker only. **Databases are not changed.** If the newer
version changed its data, the older code may not read it. Restore a database
separately if you need its data as it was.

Rollback is not offered across a change to the app's Durable Object classes:
Cloudflare refuses to roll a Worker back across such a change.

## Restore a database to a bookmark

Each snapshot holds a D1 Time Travel bookmark for every database of the app. On a
snapshot's row, select **Restore &lt;database&gt; to this point**, type the database name to
confirm, and select **Restore database**.

Everything written to that database since the snapshot is replaced. The Worker is
not changed. Cloudflare returns a bookmark of the database from just before the
restore; the manager shows it with the `wrangler d1 time-travel restore` command that
undoes the restore.

D1 keeps Time Travel history for 7 days on Workers Free and 30 days on Workers Paid.
Older bookmarks cannot be restored.
