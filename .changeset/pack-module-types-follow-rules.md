---
"@appflare/pack": patch
---

The packer records each Worker module with the type `wrangler deploy` would upload it as, read from the upload wrangler's dry run writes (`--outfile`), instead of guessing from the file extension. A wrangler config's module `rules` now decide the type as they do for wrangler: with a `Text` rule for `**/*.md` or `**/*.svg`, an imported file reaches the Worker as a string, where the packer used to record it as data and the Worker got an ArrayBuffer. Module names and bytes are unchanged. A Worker in the service-worker format (`addEventListener`) now fails the pack with a message saying so; Appflare could not install one before either.
