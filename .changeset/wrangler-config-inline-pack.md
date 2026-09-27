---
"@appflare/pack": minor
---

The packer writes a catalog entry's inline wrangler config (`install.wranglerConfigInline`) as `.appflare.wrangler.jsonc` where `wranglerConfig` names, with the install's Worker name, before the install and the build, and reads it like any other config; `appflare-pack inspect --manifest` writes it too. It refuses one where the repository has a config of its own (a template included) or a build redirect, and in a directory the checkout does not have. `writeInlineConfigs()` and `inlineConfigWorkerName()` are exported.

A wrangler config that declares a section the packer does not read (`vpc_services`, `secrets_store_secrets`, `tail_consumers` and the rest of `UNSUPPORTED_WRANGLER_SECTIONS`) now fails the pack with a message naming it and the config patch that drops it, instead of packing an app that would run without it. A test compares the packer's lists (`READ_WRANGLER_KEYS`, `IGNORED_WRANGLER_KEYS`) with the config schema wrangler ships, so a key wrangler gains must be sorted into read, ignored or refused.

`containers` is refused like the rest, since Appflare cannot install a container application. An artifact whose deployer supplies a refused section itself may be packed with an explicit allowance: `pack({ allowSections })`, or `--allow-section <key>` (repeatable) on the command line. The allowed sections are left out of the artifact without refusing the config, and the pack logs each one; `pipelines` and `unsafe`, which the packer reads against the catalog manifest, cannot be allowed, and neither can a key it does not refuse (`AllowedSectionError`, `allowedSections()`). The sandbox Worker's release is packed with `--allow-section containers`, since the manager deploys its containers from its own definition; catalog entries are never packed with an allowance.

`placement` is recorded as wrangler uploads it (`uploadPlacement()`): `mode: "off"` is no placement, a hint or `mode: "smart"` is smart placement, and `region`, `host` or `hostname` is a targeted one. Before, `{ "mode": "off" }` was recorded as written, which Cloudflare's API does not accept.
