# @appflare/pack

## 0.1.0

### Minor Changes

- 346d608: The first public release of `appflare-pack`, which turns an app's repository into a release Appflare can install. It builds the app, checks its wrangler config against the catalog manifest, and writes a zip with a manifest listing every file's hash. It signs that manifest, verifies a release before it is published, and shows which parts of a wrangler config Appflare supports.
