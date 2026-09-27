---
"@appflare/pack": minor
---

D1 migrations are found, named and ordered exactly as `wrangler d1 migrations apply` finds them: the wrangler config's `migrations_pattern` is honoured, each file is recorded by its path from `migrations_dir` (`0000_init/migration.sql` for a folder per migration), files starting with `.` and links are skipped, folders the pattern cannot reach are never read, a glob must start with a folder, and `migrations_dir` must stay inside the checkout, and migrations run in wrangler's order, leading numbers first. A database migrated by wrangler and one migrated by Appflare record the same names.

The packer reads `resources.d1` from the catalog manifest. A `migrationsDir` or a `migrations` glob replaces the wrangler config's folder and pattern. Schema files go into `d1-schema/<binding>/` and the artifact's `d1Schema`, post-deploy migrations into `d1-post-deploy/<binding>/` and `d1PostDeploy`; an artifact with either is written as format 3.

A schema file must be safe to run again: the pack fails, naming the file and line, when a CREATE TABLE, INDEX, TRIGGER or VIEW lacks `IF NOT EXISTS`, a statement drops or alters anything, or a statement changes rows a second run would change again (`UPDATE`, `DELETE`, `REPLACE`, and any `INSERT` but `INSERT OR IGNORE` or `ON CONFLICT DO NOTHING`). The check strips comments, skips strings and quoted names, and keeps a trigger's body in one statement. The pack also fails on a path that leaves the checkout (links included), a glob that matches nothing, a declaration for a binding no Worker has, and a post-deploy migration named like a migration. These checks run before anything is built. `appflare-pack verify` checks the new files' hashes and holds schema files to the same rule, and the pack summary counts them.

When the build redirects wrangler to a generated config (the Cloudflare Vite plugin's `build/server/wrangler.json`), a D1 binding's `migrations_dir` is read beside the declared config first, as `wrangler d1 migrations apply` reads it, and beside the generated config only when the folder is not there. Such apps used to pack with no migrations.
