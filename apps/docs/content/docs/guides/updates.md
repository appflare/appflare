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
  sets them before the new version serves traffic. An optional secret the new version
  adds is never asked for; set it in the app's [settings](/guides/settings/) if you
  want it.
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

An update keeps the app's settings, its secrets, its custom domains and the
[**Serve on workers.dev**](/guides/custom-domains/#turn-off-the-workersdev-url) choice.
To change settings or secrets without updating, see
[Change an app's settings](/guides/settings/).

### Apps of several Workers

For an [app of several Workers](/guides/install-apps/#apps-of-several-workers), the
job works on all of them as one app. The snapshot holds the serving version of every
Worker, together with the D1 bookmarks. Each Worker's new version is uploaded and
checked at its own preview URL, D1 migrations run before any Worker switches, and
then the Workers switch to their new versions one at a time, with the app's own
Worker last. A rollback returns every Worker to its version in the snapshot.

An update cannot add a Worker to an installed app, because the manager keeps no
secret values to give the new Worker: the job refuses such a version before anything
changes, and the app has to be installed again to get it. A Worker a new version no
longer has stays in place until the app is uninstalled.

### Apps with Durable Objects

Cloudflare gives no preview URL to a Worker that defines Durable Objects, so updates
of such apps skip step 5. When a new version also changes its Durable Object classes
(a migration, or a change to the classes its wrangler `exports` declare), Cloudflare
applies that only when the whole Worker is deployed at once. The job then deploys
directly, and the change to the classes cannot be undone with a rollback.

Once an app's `exports` declare a Durable Object class, Cloudflare refuses every
later version that does not, including one that goes back to migrations. The job
refuses such a version before anything changes; the app's config has to keep
declaring the class in `exports`, or mark it `"state": "deleted"` there to retire it.

## Automatic updates

Under **Settings**, **Automatic updates**, admins can turn on **Automatically update
apps**. It is off by default. Each app's page has an **Automatic updates** choice: use
the account setting, or turn automatic updates on or off for that app.

When automatic updates are on for an app, the cron checks every 30 minutes whether the
catalog has a newer version. It starts the update on its own only when that version
needs nothing from you:

- no value for a secret the new version adds,
- no confirmation that the new version cannot be checked before it goes live,
- no Workers Paid confirmation for more cron triggers,
- no build or installer run to approve (apps built in your account never update on
  their own).

Anything else waits for you on the app's page, as described above, and the cron does
not try that version again; it tries the next one the catalog publishes. An automatic
update runs the same job, with the same snapshot and checks. The cron starts at most
three app updates per run. It does not try a version again after its update failed,
or after you rolled the app back from it. The app's job list and the job's page show
**Automatic** under **Started by** for jobs the cron started, and **Admin** for the
others. To hear about updates that wait for you, or about automatic updates that
finished or failed, add a [notification channel](/guides/notifications/).

## Roll back

Each update and each [settings change](/guides/settings/) adds a row under
**Versions** on the **Jobs** tab of the app's page: when the snapshot was taken, the catalog version, and
the Worker version. Select **Roll back** on a row to deploy that Worker version again
to all traffic, with the settings and secrets it had then. A rollback runs as a job
and ends with a health check. If automatic updates were on for the app, the rollback turns
them off, so the cron does not install the version you left again; turn them back on
on the app's page once a fixed version is out.

A rollback changes the Worker and its settings and secrets only. **Databases are not
changed.** If the newer version changed its data, the older code may not read it.
Restore a database separately if you need its data as it was. A rollback does not move
an app's email back to another zone either; see
[What a rollback puts back](/guides/settings/#what-a-rollback-puts-back).

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
