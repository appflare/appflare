---
"@appflare/schema": patch
---

The descriptions of `bump` and `bump.autoMerge` follow the catalog's new rule. The catalog checks that each upstream release builds, matches its hashes and installs, and users decide whether to update, so the catalog's bump bot reads `autoMerge` from the manifest file itself: left out or `true`, a bump of an artifact tier entry that does not set `source.version` merges itself once the required checks pass; `"bump": { "autoMerge": false }` opts out. Sandbox and self-deploying entries are never merged by the bot and still may not set `true`. Parsing is unchanged: the parsed value still defaults to `false`, only so that released catalog manifests keep their bytes, and it does not mean the entry opts out.

`codemod-manifest-v1` now keeps an explicit `"bump": { "autoMerge": false }` instead of dropping it as the default, since dropping it would now let the entry's bumps merge themselves.
