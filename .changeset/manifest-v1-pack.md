---
"@appflare/pack": major
---

The packer reads and writes the v1 catalog manifest and artifact.

- The catalog manifest is read strictly: a key the schema does not know refuses the pack and names its path (`install.healthpath is not a field here; check its spelling`), and every problem is listed as `- <path>: <message>`. The license must be a current SPDX expression, a `LicenseRef-<name>` or `NONE`; the old warning for anything else is now a refusal. Categories, the tagline, token permissions and placeholders are checked by the schema too.
- `--repository-build` (`repositoryBuild` in `pack()`) is for the manifest Appflare works out for an app built from a repository without a catalog entry: its license may also be `NOASSERTION` or `SEE LICENSE IN <file>`.
- Artifacts are written in the one v1 format (`format: 1`): the D1 SQL of each binding sits under `d1[binding]` (`migrations`, `schema`, `postDeploy`, `baseline`), there is no top-level `source` (the embedded catalog manifest carries it), and `worker.wranglerConfig` is always recorded. The written manifest is checked strictly before anything is written. `appflare-pack verify` reads it strictly too and names a later format.
- The version comes from `source.version` (was `install.version`); the pack summary says `version from source.version in the catalog manifest`. `resources.hyperdrive` is keyed by binding, a D1 glob is `resources.d1[binding].migrationsGlob`, and an omitted `install.workerName` falls back to the slug.
- Placeholders in the wrangler config's vars are held to the list a var's `default` takes: a known name in the wrong case (`{{appURL}}`), `{{stage}}`, or a per-Worker form naming a Worker the entry does not have refuses the pack.
- `readCatalogManifest` is exported for tools that check an `appflare.jsonc` the way the packer does.
