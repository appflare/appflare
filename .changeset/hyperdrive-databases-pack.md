---
"@appflare/pack": minor
---

Apps with a Hyperdrive binding can be packed when the catalog manifest declares the binding under `resources.hyperdrive`. The artifact records the binding by name only, never the configuration id or a local connection string from the wrangler config. A Hyperdrive binding the manifest does not declare, or a declaration the config does not bind, fails the pack before anything is built, naming the binding and the field to fix, and `appflare-pack verify` holds an artifact's Hyperdrive bindings to its embedded catalog manifest the same way.

A wrangler config kept only as a template (`wrangler.toml.example`, `wrangler.jsonc.template`) can be named in `install.wranglerConfig`: the packer, and `appflare-pack inspect`, copy it beside itself under its real name before the build runs and wrangler reads it, since wrangler reads a config by its extension. A real file of that name that differs from the template, or is a link, fails the pack. The artifact records the template as the declared config and the copy as the one read.
