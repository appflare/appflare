---
"@appflare/sandbox-worker": minor
---

Builds use the v1 catalog manifest and artifact. The manifest worked out for a repository without a catalog entry has a tagline (the first line of `package.json`'s description, else `Built from <owner/repo>`), the category `utilities`, its version in `source.version`, and one optional setting per wrangler var. Its license is `package.json`'s when that is an SPDX expression, `NONE`, `NOASSERTION` or `SEE LICENSE IN <file>`, and `NOASSERTION` otherwise (npm's `UNLICENSED` or free text such as `MIT License`); such a build is packed with `appflare-pack --repository-build`. A build from source of a catalog app keeps the catalog's manifest with the new commit and its version in `source.version`. The check of a packed artifact reads the commit and repository from its embedded catalog manifest.
