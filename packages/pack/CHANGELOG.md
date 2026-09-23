# @appflare/pack

## 0.2.0

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

## 0.1.0

### Minor Changes

- 2cd768a: `appflare-pack` warns in its summary when a Worker has more modules than
  Appflare can upload in one request on the free plan (`MAX_WORKER_MODULES`,
  exported by both packages), and `appflare-pack verify --max-modules <n>` fails
  such an artifact, so catalog CI can reject packs Appflare could never install.
