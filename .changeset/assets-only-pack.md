---
"@appflare/pack": minor
---

A wrangler config with `assets` and no `main` packs as a Worker of static assets only: the dry run still runs (and with it the config's `build.command`), the no-op placeholder Worker wrangler emits is not recorded, the artifact records the assets and no modules, and it is written as format 5. Bindings, vars, catalog secrets and vars aimed at it, Durable Object migrations or exports, cron triggers, queue consumers, an assets binding and `run_worker_first` are refused before anything is built, since the Worker has no code to use them; observability, placement, limits and cache settings are left out with a log line, as wrangler leaves them out. A config with neither `main` nor `assets.directory` is still refused.

`install.installDirs: []` installs nothing and says so in the log, as does a build command that then runs with no dependencies installed.
