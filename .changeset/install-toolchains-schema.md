---
"@appflare/schema": minor
---

Add `install.toolchains` to the catalog manifest: `["rust"]` marks a workers-rs app whose build needs a Rust toolchain, which catalog CI installs before the pack. Only the `artifact` tier takes it; the `sandbox` and `self-deploying` tiers are refused with a message saying the sandbox image has no Rust. New exports: `CATALOG_TOOLCHAINS`, `catalogToolchainSchema` and `installToolchains`. `wranglerFactsSchema` gains `secrets`, the names in the wrangler config's `secrets.required`, defaulting to none for output from an older packer. The catalog manifest schema now refuses a name declared both as a secret and as a var: a Worker cannot have both.
