# @appflare/manager

## 0.4.0

### Minor Changes

- e9aef76: Apps that bind a Vectorize index can be installed. A wrangler config cannot
  say how to create the index, so the catalog manifest states it in
  `resources.vectorize`, keyed by binding name:
  `{ "dimensions": 1-1536, "metric": "cosine" | "euclidean" | "dot-product" }`.
  The packer records both on the artifact's Vectorize binding and refuses a
  Vectorize binding the catalog manifest does not declare (and a declaration for
  a binding the wrangler config does not have), naming the field to add;
  `verify` checks the two agree. The artifact schema types the Vectorize binding,
  and the manager creates the index from it at install, binds it by name, and
  deletes it on uninstall when ticked. An update whose version changes the
  dimensions or metric of an index the install already has is refused before
  anything changes: an index cannot be reshaped in place, so that version needs a
  fresh install.

### Patch Changes

- 1d222e9: List an app's account requirements on its catalog page with a sentence each, and ask the admin to confirm the account meets them before the Install button enables; installs started without that confirmation are refused. An install that needs an R2 bucket now checks that R2 is enabled before creating anything, and explains how to enable it (a payment method on file, even for the free tier) instead of showing Cloudflare's raw error.
- 79229be: Show the Cloudflare token an app needs for itself on its catalog page and install page: each permission with its scope and purpose, and a "Create token" link that opens the dashboard's token form with the recognized permissions selected.
- bba65db: Installing or updating an app with many static asset files no longer fails with
  "Too many subrequests". The asset upload now reads neighbouring files from the
  release artifact with a single range request, follows the release download's
  redirect once per step instead of once per file, and splits an upload group
  that would not fit one step into several uploads. If the free plan's
  subrequest limit is reached anyway, the job stops at once with an explanation
  instead of retrying into the same limit.
- 9205396: Show on each catalog card when the catalog's nightly install check last passed ("Verified" with the day, the exact time on hover, or "Not verified yet"), and show the account requirements as icons named on hover. The app's catalog page uses the same verified badge, and the token section now says an app's token is stored on the app's Worker, never on the manager's.
- 5cddddd: The health check at the end of an install, update, or rollback now keeps
  probing for up to 90 seconds with backoff (2, 3, 5, 8, then every 10 seconds),
  since a new workers.dev route can take longer than 20 seconds to go live. It no
  longer fails the job: everything is already created or promoted by then, so the
  job succeeds, logs a warning when the Worker could not be verified, and records
  the result on the install (verified, not verified yet, or unhealthy for a 5xx).
  A plain 404 passes once the window ends, as apps may serve 404 at their root.
  The install job now probes the catalog's `install.healthPath` like the update
  job does. The install page shows the health with the time of the last check and
  a "Check now" button for admins; the installed list flags installs that are
  unhealthy or not verified yet.
- Updated dependencies [68d6c97]
- Updated dependencies [e9aef76]
  - @appflare/schema@0.3.0

## 0.3.1

### Patch Changes

- 2cd768a: The release is built as a single server module so Appflare can update itself.
  A self-update fetches every module of the new version for one upload, and the
  code-split build had too many modules to fit the free plan's subrequest limit.
  Self-updates, app updates, and installs now check the module count in their
  own step ("check release shape", "plan update", "preflight checks") before
  changing anything, and say how many modules fit.
- Updated dependencies [2cd768a]
  - @appflare/schema@0.2.0

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
