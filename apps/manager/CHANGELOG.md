# @appflare/manager

## 0.3.0

### Minor Changes

- f2a62aa: Appflare can now update itself. Every 30 minutes the manager checks its own
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

## 0.2.0

### Minor Changes

- 40fa540: Update installed apps, roll them back, and restore their databases.
  
  - **Update**: when the catalog has a newer version of an app, its page shows "Update available to <version>" with an Update button. The update first takes a snapshot (the Worker version serving traffic and a D1 Time Travel bookmark of each database), creates resources for bindings the new version adds (it never deletes any; bindings that went away are left in place), uploads the new version without serving it, and checks it at its preview URL. Only when the preview answers does it apply new D1 migrations and move all traffic to the new version, then check the app's own URL. If the preview check fails, nothing is promoted and the previous version keeps serving. Existing secrets carry over unchanged.
  - **New secrets**: when a new version declares secrets the app does not have yet, the Update button opens a form for them (generated ones are prefilled); they are set with the new version.
  - **Durable Objects**: a version that brings Durable Object migrations is deployed in one step with its migrations, because Cloudflare applies them only that way; Workers that implement a Durable Object have no preview URL. The update dialog says so and asks for confirmation before such an update, which relies on the health check after it deploys.
  - **Health path**: a catalog entry may set `install.healthPath` (for example `/api/health`). Checks probe that path, and when it answers JSON with a `version`, the check of a new version requires it to match.
  - **Versions and rollback**: the app's page lists every snapshot (when it was taken, the catalog and Worker versions it moved between). "Roll back" redeploys the version that served before an update and restores the recorded catalog version; it never changes data. It is not offered for an update that changed Durable Object classes, because Cloudflare refuses to roll a Worker back across such a change. A rollback deploys even when a secret changed since that version.
  - **Database restore**: admins can restore each D1 database to a snapshot's bookmark after typing the database's name. The restore is recorded in the app's job history, and the dialog shows the bookmark from just before the restore so it can be undone.

### Patch Changes

- Updated dependencies [40fa540]
  - @appflare/schema@0.1.0

## 0.1.0

### Minor Changes

- b2f4d20: Uninstall apps, and install one app more than once.
  
  - **Uninstall**: an install's page has an Uninstall button. The dialog lists the app's data resources (KV namespaces, D1 databases, R2 buckets, queues, Vectorize indexes) with a checkbox each, shows KV key counts and D1 sizes, and asks you to type the Worker name. The uninstall job deletes the Worker (with its routes, cron triggers, secrets, Durable Objects, and Workflows) and every ticked resource, emptying R2 buckets first. Unticked resources stay in the account and are listed on the install's page. If the job stops part way, "Retry uninstall" deletes what is left, and lets you keep anything Cloudflare refuses to delete (such as an R2 bucket with incomplete multipart uploads). Failed installs can be uninstalled the same way; a Worker is only deleted when Appflare created it for that install.
  - **Several instances of an app**: install the same app again under another Worker name; the form suggests the next free one (`cut-2`) and lets you name each install. Apps whose catalog entry sets `install.fixedWorkerName` still install once.
  - The installed apps list shows each install by name and Worker; uninstalled installs are in a collapsed section.

## 0.0.1

### Patch Changes

- 4985115: Initial manager shell
