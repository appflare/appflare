---
"@appflare/pack": minor
"@appflare/schema": minor
---

The packer now follows a redirected wrangler config the way `wrangler deploy` does. Build tools such as the Cloudflare Vite plugin (used by React Router, TanStack Start, and other Vite apps) write the deployable config under their output directory and leave `.wrangler/deploy/config.json` beside the app's own config, pointing at it. The packer used to bundle with `--config <install.wranglerConfig>`, which ignores that redirect, so such apps failed with errors like `Could not resolve "virtual:react-router/server-build"`; pointing `install.wranglerConfig` at the generated config instead failed with `The "legacy_env" field is no longer supported`, because wrangler reads a config passed with `--config` as hand-written.

After installing dependencies and running `install.buildCommand`, the packer looks for `.wrangler/deploy/config.json` in the directory of `install.wranglerConfig`. When it is there, the packer reads the config it points at (resolved from the redirect file's directory, as wrangler does) with wrangler's own reader in redirect mode, and bundles with `wrangler deploy --dry-run` run from that directory without `--config`, so bindings, assets, and D1 migrations come from the generated config. A redirect that is not JSON, has no `configPath`, names a missing file, or points outside the checkout fails the pack. Without a redirect nothing changes.

The artifact manifest records which config was used in `worker.wranglerConfig`, as `{ declared, effective }` paths relative to the checkout; they differ only when the build redirected wrangler. The field is optional, so artifacts packed before it keep their shape.
