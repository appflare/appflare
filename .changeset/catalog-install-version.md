---
"@appflare/pack": minor
"@appflare/schema": minor
---

A catalog manifest can state its app's version in `install.version` (semver
without a leading `v`) for repositories whose tags do not describe the app, such
as a monorepo of many templates. The packer uses it over the `source.ref` tag and
the commit-date rule, rejects a value that is not semver, and says in its summary
and `PackResult.versionOrigin` which rule produced the version.
`deriveVersionWithOrigin` and `semverSchema` are exported.
