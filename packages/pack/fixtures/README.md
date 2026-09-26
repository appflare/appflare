# pack fixtures

`fixtures/hello/` is a real, minimal wrangler project used by the packer's tests
and by the `appflare-pack` acceptance run. It has **no dependencies**, so it packs
with `--no-install`.

It exercises: static assets in nested directories, an `.assetsignore` file
(`robots.txt` and the ignore file itself are excluded), a D1 binding with a
`migrations_dir` holding two `.sql` files, a KV binding whose `id` must be
stripped, plain `vars`, and a cron trigger. `appflare.jsonc` is its catalog
manifest.

`fixtures/duo/` is an app of two Workers (`install.workers`): `web/` is the
primary Worker and `jobs/` the other. It exercises a service binding and a
Durable Object binding from one Worker to the other, a self binding, a D1
database both Workers bind with the same migrations, a queue one Worker sends
to and the other consumes, and secrets and vars aimed at one Worker. It has no
dependencies either.

This tree is deliberately kept out of the workspace's tooling:

- **turbo**: it is not a workspace package (no `package.json`, and
  `pnpm-workspace.yaml` only globs `packages/*`), so no task runs here.
- **biome**: `packages/pack/biome.json` excludes `fixtures/**`, because the
  fixture's `wrangler.jsonc`, HTML, and CSS are intentionally hand-written and
  must not be reformatted.
- **vitest**: `packages/pack/vitest.config.ts` scopes tests to `src/**`.
- **typecheck**: `tsconfig.json` includes only `src` (and `vitest.config.ts`),
  so the fixture Worker (which references ambient Cloudflare runtime types) is
  never type-checked here.
