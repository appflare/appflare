---
"@appflare/pack": minor
---

The packer applies a catalog entry's config patch after the entry's build commands and before wrangler reads the config, so a build command that reads the wrangler config itself sees it unpatched. It writes the patched config beside the original as `.appflare.wrangler.jsonc`, so relative paths keep resolving, bundles from it, and prints each change in the pack log. A TOML config is parsed with wrangler's own parser and written as JSONC. A patch the config does not allow, a config the build redirected to one it generated, and a link in place of the patched file are refused. The artifact records the patched file as the effective config. `appflare-pack inspect --manifest <appflare.jsonc>` applies the entry's patch first and reports the patched config. `applyConfigPatches()`, `workerSpecs()` and `readRawWranglerConfig()` are exported.
