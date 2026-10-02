---
"@appflare/pack": minor
---

Apps of several Workers built by the Cloudflare Vite plugin now pack. A Workflow binding whose `script_name` names another Worker of the entry is recorded as `{{workerName:<name>}}` instead of failing the pack, and one naming its own Worker is recorded without it. A Worker whose config the build generated for an auxiliary Worker (listed in the redirect's `auxiliaryWorkers`) is packed from that generated config: name its own config (`wrangler.audit.jsonc`) and the packer finds the one generated from it. A generated config read without the redirect is read without `legacy_env`, which older plugin versions write and wrangler accepts only through the redirect. A config patch on a config the build generated now applies to that config after the build, as long as it does not change `main`, `assets.directory` or `build`; `wrangler deploy --dry-run` and wrangler's reader now take the config the packer wrote with `--config`.
