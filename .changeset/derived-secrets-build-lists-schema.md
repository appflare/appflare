---
"@appflare/schema": minor
---

Catalog manifests gain three things apps such as Counterscale and Sink need.

- `{{accountId}}` joins `{{workerUrl}}` and `{{workerName}}` as a placeholder in `postInstall` text, var defaults and the wrangler config's vars, for apps that call the Cloudflare API about their own account (the Analytics Engine SQL API, for example). `PlaceholderValues.accountId` is optional; where it is absent or null, `{{accountId}}` stays as written.
- A secret may declare `derive: { from: "<secret>", method: "bcrypt" }`: the manager computes it from the source secret's value instead of asking for it (a `$2b$` bcrypt hash at cost 10, `BCRYPT_COST`). The source must be another secret of the manifest that is neither derived nor optional, and a derived secret may not be `generate` or `optional`; self-deploying entries may not use it. `enteredSecrets()`, `isDerivedSecret()` and `derivedSecretProblems()` go with it.
- `install.buildCommand` may be a list of up to 8 commands (`MAX_BUILD_COMMANDS`), each under the same rules as a single one, run in order. `buildCommandList()` and `buildCommandText()` read either form. A sandbox build request repeats the command only when the entry declares exactly one; a self-deploying run request carries one argv as before, or a list of argvs when the entry lists several (`buildCommandRequestArgv()`, `buildCommandArgvList()`). The repository build's detected `buildCommand`, shown to the admin, may now hold such a list on one line.

An artifact's `worker.observability` no longer needs a top-level `enabled`: wrangler accepts a config that turns on only logs (`[observability.logs] enabled = true`), records it as written and uploads it unchanged, and so do the packer and the manager.

A manager older than this one refuses an artifact whose catalog manifest lists several build commands, asks for a derived secret as if it were an ordinary one, and leaves `{{accountId}}` as written.
