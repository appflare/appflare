---
"@appflare/pack": minor
---

The packer runs every command of a catalog manifest's `install.buildCommand` list in order, stopping at the first that fails (`runBuildCommands`); the commands share the 15-minute build limit, and every one is checked before the first runs. Messages name a command of a list as `install.buildCommand (2 of 3)`.

Build commands now run with pre and post hooks of package scripts off for pnpm and npm (`BUILD_HOOKS_OFF_ENV`: `npm_config_enable_pre_post_scripts=false`, `npm_config_ignore_scripts=true`), matching the dependency install's `--ignore-scripts`: `pnpm run build` no longer runs `prebuild` first (pnpm 10 runs such hooks by default). A step a hook ran belongs in the list as a command of its own. Bun and classic yarn read neither setting.

A pack reports the Worker's size the way wrangler measures it (every module's bytes, and gzipped as one stream) against Cloudflare's 64 MiB uncompressed limit, which now applies on every plan with no compressed limit, and the module count against the most the manager uploads: `appflare-pack` prints a `worker:` line, `PackResult.workerSize` carries the numbers, and `packWarnings` warns about a Worker over 64 MiB. `artifactWorkerSize()` measures a packed artifact from its zip, and `workerSizeLine()` formats the line.

`deriveSecretValue()` computes a derived secret (a catalog secret's `derive`) from its source's value as the manager does, so tooling that installs an artifact outside the manager, such as the catalog's install check, can set it too. Adds the `bcryptjs` dependency for it.
