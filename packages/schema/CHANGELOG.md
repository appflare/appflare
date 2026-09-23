# @appflare/schema

## 0.3.0

### Minor Changes

- 68d6c97: A catalog manifest can state its app's version in `install.version` (semver
  without a leading `v`) for repositories whose tags do not describe the app, such
  as a monorepo of many templates. The packer uses it over the `source.ref` tag and
  the commit-date rule, rejects a value that is not semver, and says in its summary
  and `PackResult.versionOrigin` which rule produced the version.
  `deriveVersionWithOrigin` and `semverSchema` are exported.
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

## 0.2.0

### Minor Changes

- 2cd768a: `appflare-pack` warns in its summary when a Worker has more modules than
  Appflare can upload in one request on the free plan (`MAX_WORKER_MODULES`,
  exported by both packages), and `appflare-pack verify --max-modules <n>` fails
  such an artifact, so catalog CI can reject packs Appflare could never install.

## 0.1.0

### Minor Changes

- 40fa540: Update installed apps, roll them back, and restore their databases.
  
  - **Update**: when the catalog has a newer version of an app, its page shows "Update available to <version>" with an Update button. The update first takes a snapshot (the Worker version serving traffic and a D1 Time Travel bookmark of each database), creates resources for bindings the new version adds (it never deletes any; bindings that went away are left in place), uploads the new version without serving it, and checks it at its preview URL. Only when the preview answers does it apply new D1 migrations and move all traffic to the new version, then check the app's own URL. If the preview check fails, nothing is promoted and the previous version keeps serving. Existing secrets carry over unchanged.
  - **New secrets**: when a new version declares secrets the app does not have yet, the Update button opens a form for them (generated ones are prefilled); they are set with the new version.
  - **Durable Objects**: a version that brings Durable Object migrations is deployed in one step with its migrations, because Cloudflare applies them only that way; Workers that implement a Durable Object have no preview URL. The update dialog says so and asks for confirmation before such an update, which relies on the health check after it deploys.
  - **Health path**: a catalog entry may set `install.healthPath` (for example `/api/health`). Checks probe that path, and when it answers JSON with a `version`, the check of a new version requires it to match.
  - **Versions and rollback**: the app's page lists every snapshot (when it was taken, the catalog and Worker versions it moved between). "Roll back" redeploys the version that served before an update and restores the recorded catalog version; it never changes data. It is not offered for an update that changed Durable Object classes, because Cloudflare refuses to roll a Worker back across such a change. A rollback deploys even when a secret changed since that version.
  - **Database restore**: admins can restore each D1 database to a snapshot's bookmark after typing the database's name. The restore is recorded in the app's job history, and the dialog shows the bookmark from just before the restore so it can be undone.
