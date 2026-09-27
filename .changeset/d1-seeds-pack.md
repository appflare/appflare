---
"@appflare/pack": minor
---

The packer accepts D1 seed statements (`resources.d1[binding].seed`) and seed-only secrets and vars. Seeds are checked as the catalog manifest is read, before anything is built: one guarded INSERT per statement, one param per `?`, and every param naming a declared var, secret or hash. The artifact carries them in its signed catalog manifest and is written as format 4; the pack summary counts them. A seed-only secret the wrangler config requires in `secrets.required`, or a seed-only var the config also declares, is refused, since the Worker never gets either; a seed-only secret no longer takes the place of a config var of its name. The SQL checks now come from `@appflare/schema`.
