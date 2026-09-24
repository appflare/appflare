---
"@appflare/sandbox-worker": patch
"@appflare/schema": patch
"@appflare/cli": patch
---

The sandbox Worker reports which of its versions answers: it gains a version metadata binding (`CF_VERSION_METADATA`), and `info()` returns its id as `versionId`, which the manager waits on after a secret change. When a new version of the sandbox Worker resets a build's or an installer run's container before its first command went through ("interrupted while the platform was updating the sandbox runtime", "Durable Object reset because its code was updated"), the run starts again once in a fresh container (`<id>-r`) instead of failing; the run's log notes it, and only a second reset fails the run. `appflare sandbox enable` declares the version metadata binding when the release carries it, and still deploys releases without it. A CLI older than this one refuses sandbox Worker releases from now on, because it does not know the new `version_metadata` binding; that is intended (it would deploy them without it), and `npx @appflare/cli@latest sandbox enable` deploys them.
