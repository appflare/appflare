---
"@appflare/manager": major
---

The manager reads the v1 catalog manifest, artifact and index, and nothing written in the earlier shapes: an artifact of another format is refused with a message that says to update Appflare, and existing installs are expected to start fresh.

- The link that creates an app's own Cloudflare API token is prefilled from the structured `tokenPermissions` (group, scope, access, reason), each group's template key coming from the schema's list; a group this version does not know is listed with "Not selected for you". The field that takes the token is the secret marked `cloudflareToken: true` (or a Pipelines sink's token secret), no longer guessed from its name.
- Categories come from the schema's fixed list, with its labels and an icon each; an id a custom catalog uses that the list does not know gets a readable label but no card or row of its own. Slugs the catalog folded before the list was fixed are no longer mapped.
- Licenses link only ids of the SPDX License List, and an entry's `licenseNote` is shown on its page.
- `{{appUrl}}` and `{{appHostname}}` are the address the app is served at: its custom domain while workers.dev is off, else workers.dev. When a domain takes over from workers.dev, workers.dev comes back when the last domain goes, the domain that serves the app is removed, or the "Serve on workers.dev" switch moves, the app's settings that use them are deployed again. `{{workerUrl}}` and `{{workerHostname}}` are always the workers.dev address, and a setting that uses them keeps workers.dev on. Every placeholder shows as a chip in the forms, per-Worker forms included.
- Fields follow their new shapes: `install.health`, `install.container`, `source.version`, `install.wildcardHostname.reason`, `selfDeploying.workerNames`, `resources.hyperdrive` keyed by binding, one `optional` flag on vars and secrets, `generate` as a string, and the defaults for the tier, the Worker name and the homepage. Health modes are `no-server-errors` and `any-response`; a self-deploying app is checked with the mode its entry sets, `no-server-errors` when it sets none, like any other app (it was `status-only` before).
- Index rows carry the release digest in `artifacts` and always publish their services, categories, license, authors and tagline, which the catalog list reads directly; the tagline is the line under an app's name.
