---
"@appflare/schema": patch
"@appflare/cli": patch
---

The schema names the sandbox Worker's version metadata binding (`SANDBOX_VERSION_METADATA_BINDING`, `CF_VERSION_METADATA`), and the sandbox Worker's `info()` answer takes an optional `versionId`, the id of the version that answered, which the manager waits on after a secret change. `appflare sandbox enable` declares the version metadata binding when the release carries it, and still deploys releases without it. A CLI older than this one refuses sandbox Worker releases from now on, because it does not know the new `version_metadata` binding; that is intended (it would deploy them without it), and `npx @appflare/cli@latest sandbox enable` deploys them.
