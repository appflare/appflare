---
"@appflare/pack": patch
---

A wrangler config's own `build.command` runs in the config's directory, as it does when an app runs `wrangler deploy` beside its config, instead of at the repository root. Wrangler runs a custom build in the directory it was started in, so a command such as `npm run build` in a config below the root failed to find its `package.json`, and catalog entries replaced it with `build: null` and an `install.buildCommand`. Those entries keep working.
