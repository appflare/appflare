---
title: Submit an app
description: Add an app to the Appflare catalog with one manifest file and a pull request.
---

Adding an app takes one file, `apps/<slug>/appflare.jsonc`, in a pull request to
[appflare/catalog](https://github.com/appflare/catalog). You do not need to change the
app's own repository.

## Before you start

- **The app needs a public repository.** Its license does not decide whether it is
  listed: the catalog takes any app the platform can run, open-source,
  source-available, or with no license at all, and shows the license as the
  repository declares it. See [`license`](#1-write-the-manifest) below.
- **No proxies, tunnels, or circumvention tools.**
- **It deploys with wrangler.** If the app works with Cloudflare's Deploy button, it
  should work with Appflare. Bindings, compatibility settings, static assets, Durable
  Object migrations, queue consumers, and cron triggers all come from the app's own
  wrangler config; the manifest does not repeat them. An app that needs a build step
  before `wrangler deploy` (Vite, React Router, OpenNext) and has no `build.command`
  in its wrangler config names that step in `install.buildCommand`.
- **It is self-contained.** Durable Objects and Workflows must be defined by the app's
  own Worker, not bound from another Worker. The only service binding an app may have
  is one to its own Worker (its `service` is the wrangler config's own `name`, as
  OpenNext's `WORKER_SELF_REFERENCE` is), optionally with an `entrypoint`. A service
  binding to any other Worker fails the pack, because an app must never be able to
  call another app or Appflare itself. An app made of several Workers lists them all
  in its entry; see [Apps of several Workers](#apps-of-several-workers).
- **Each Worker fits one upload.** The manager installs apps from inside a Workflow
  on the free plan, which allows 50 subrequests per invocation, and uploads each
  Worker in one request. It reads modules that lie next to each other in the
  artifact with one Range request per 8 MiB, so a build may emit as many modules
  as it likes, but a Worker's modules may add up to at most 32 MiB: the upload
  holds all of them in memory at once.
- **It fits the free plan, or says it does not.** An app that needs paid features
  is `"plan": "paid"`. Size does not decide the plan: Cloudflare accepts a Worker
  of up to 64 MiB uncompressed on every plan, and Appflare installs a Worker whose
  modules add up to at most 32 MiB on either.

The manager creates KV namespaces, D1 databases, R2 buckets, queues, Vectorize
indexes, and Pipelines streams with their sinks and pipelines for an app, attaches the app's Worker to the queues it consumes (dead-letter
queues included), and passes through Workers AI, Browser Rendering, Analytics Engine,
email sending (with its address restrictions), rate limits, Images, version metadata,
and plain variables. A rate limit declared the older way, in `unsafe.bindings` with
`"type": "ratelimit"`, is installed like one in `ratelimits`; every other `unsafe`
binding fails the pack, since Appflare cannot tell what it needs. Each install gets
rate limit counters of its own. A service binding to the app's own Worker is pointed
at the installed Worker, whatever name it is installed under; set
`install.fixedWorkerName` only when something else in the app needs one fixed name.
Other binding types cannot be installed yet: a wrangler config that declares one
(Workers VPC services, Secrets Store secrets, Tail Workers, dispatch namespaces,
Containers, AI Search, Media, Stream, inbound email `addresses`, Workers Sites, and
the rest wrangler knows) fails the pack with a message naming it, rather than
installing an app that would run without it. When the app works without that
section, drop it with the config patch the message names, such as
`{ "vpc_services": null }`.

An app that needs every name under one hostname, such as a tunnel that gives each
session `<id>.<hostname>`, sets `install.wildcardHostname: true` and a one-sentence
`install.wildcardReason` that the admin sees when assigning the hostname. Appflare
then serves the app's Worker on the hostname the admin chooses and every name under
it, through Workers routes in one of the account's domains (see
[Wildcard domains](/guides/custom-domains/#wildcard-domains)). An app that needs its
hostname in a variable uses `{{wildcardHostname}}`, for example
`{ "name": "TUNNEL_DOMAIN", "label": "Tunnel domain", "default": "{{wildcardHostname}}" }`.

An app whose data lives in a PostgreSQL or MySQL database outside Cloudflare, reached
through Hyperdrive, is installed too: its manifest declares the database (see
[Databases elsewhere](#1-write-the-manifest)), and the admin enters its connection
string at install. The catalog's [install check](#2-open-a-pull-request) has no
database of the app's own to connect to, so it skips an app with Hyperdrive bindings
and says so, unless the catalog repository has a `HYPERDRIVE_TEST_URL` Actions secret
holding a connection string to a throwaway test database; then it installs the app
against that database. The check does not support mTLS certificate bindings yet: it
fails with a message naming the binding, so such an app cannot pass its pull request
checks. Queues, email sending, and a service
binding to the app's own Worker are deployed as the manager would deploy them; the
check points a self binding at the Worker it deploys. A service binding to any other
Worker already fails the pack.

## 1. Write the manifest

Create `apps/<slug>/appflare.jsonc`. The folder name must equal `slug`. A complete
example:

```jsonc
{
  "$schema": "https://appflare.github.io/catalog/schema/v1.json",
  "slug": "cut",
  "name": "Cut",
  "summary": "Self-hosted link shortener on Workers + KV.",
  "homepage": "https://github.com/MendyLanda/cut",
  "repo": "MendyLanda/cut",
  "license": "MIT",
  "categories": ["utilities"],
  "authors": [{ "name": "Mendy Landa", "github": "MendyLanda" }],
  "maintainers": ["MendyLanda"],
  "source": { "ref": "v0.1.0", "sha": "6056400d47530aa87e4ae5764b37ffca9d00e87f" },
  "install": {
    "tier": "artifact",
    "packageManager": "pnpm",
    "wranglerConfig": "wrangler.jsonc",
    "workerName": "cut"
  },
  "plan": "free",
  "requires": [],
  "secrets": [
    {
      "name": "ADMIN_PASSWORD",
      "label": "Admin password",
      "help": "Used to sign in to /admin.",
      "generate": true
    }
  ],
  "vars": [
    {
      "name": "HOME_PAGE",
      "label": "Home page",
      "help": "What / shows. Short links and /admin work the same either way.",
      "type": "select",
      "options": [
        { "value": "default", "label": "Landing page" },
        { "value": "404", "label": "Empty 404" },
        { "value": "admin", "label": "Redirect to /admin" }
      ],
      "default": "default"
    }
  ],
  "postInstall": [
    {
      "type": "markdown",
      "content": "Open {{workerUrl}}/admin and sign in with the admin password to create your first link."
    }
  ],
  "tokenPermissions": []
}
```

Points that need care:

- **`tagline`** (optional). What the app does, as one plain sentence of at most 80
  characters without a trailing period, such as `"Short links on your own domain"`.
  Managers show it under the app's name on catalog tiles. Write it for someone who
  is not a developer. Without it, tiles show the first clause of `summary`.
- **`license`.** Write the license the app's own repository declares, as an SPDX
  license expression: `MIT`, `Apache-2.0`, `MIT OR Apache-2.0`, or a
  source-available license such as `BUSL-1.1`, `FSL-1.1-MIT`, `PolyForm-Noncommercial-1.0.0`
  or `Elastic-2.0`. Use `NONE` when the repository publishes no license, and
  `SEE LICENSE IN <file>` (a path in the repository) for a license with no SPDX id.
  Add `licenseNote`, one short line such as `"Source-available: production use
  restricted; see the license"`, when the id does not say what matters. Managers
  show the license on the app's card and page: `NONE` as **No license**, and
  source-available licenses (and any license with a note) marked
  **Source-available**. It is never a reason to leave an app out.
- **`source`.** Set `sha` to the full 40-character commit SHA, and `ref` to the tag it
  belongs to (`v1.2.3`) or the branch (`main`) for an untagged app. A semver tag
  gives the version `1.2.3`; anything else gives `0.0.0-<commit date>.<sha7>`.
- **`install.version`.** Only for repositories whose tags do not describe this app,
  such as a monorepo of templates. It overrides the version and must change whenever
  `source` moves.
- **`install.healthPath`.** Set it when `/` returns an error or needs a login, so
  the health check requests a path that answers.
- **`install.healthMode`.** Set it to `"status-only"` when every route of the app,
  its health path included, sits behind Cloudflare Access or the app's own sign-in.
  Such an app can answer the check with an error of its own, and any answer from its
  Worker then counts as healthy. See [Health checks](/guides/health/#apps-behind-a-sign-in).
- **`install.buildCommand`.** One command, such as `pnpm --filter @scope/web build`,
  that the packer runs at the root of the repository after installing dependencies
  and before bundling, or a list of up to eight such commands run in order, such as
  `["pnpm run build:sphere", "pnpm run build"]`. Each runs without a shell and
  without credentials, with the repository's `node_modules/.bin` on its PATH, so
  pipes, redirects, quotes, variables, and `NAME=value` assignments are refused.
  pnpm and npm run no `pre` or `post` hooks there (`pnpm run build` skips
  `prebuild`), just as dependencies install with `--ignore-scripts`, so list such a
  step as a command of its own. The build stops at the first command that fails.
- **`install.installDirs`.** The directories whose dependencies the packer installs,
  in order, such as `[{ "path": "templates/blog" }]` for a template repository whose
  Worker has its own `package.json` and no root one. Omitted, only the root is
  installed; list `"."` as well when the root still needs its install. Each entry may
  name its `packageManager`; without one, a directory uses `install.packageManager`
  when it holds that manager's lockfile or none, and otherwise the one its lockfile
  names. Set `"lockfile": "none"` only when upstream ships no lockfile for that
  directory: the packer then resolves the dependencies itself, still with
  `--ignore-scripts`, and prints the sha256 of the lockfile it wrote. A directory
  that holds a lockfile always installs from it, and any other directory needs one in
  it or above it (a workspace's), or the pack fails. For a repository without a
  `package.json`, set `"installDirs": []` to install nothing: wrangler still bundles
  the entry and every file it imports by a relative path, an import of a package fails
  the pack, and any build command runs with no dependencies installed.
  `"lockfile": "none"` is no substitute there: pnpm and bun refuse a directory without
  a `package.json`, and npm looks for one in the directories above the checkout.
- **`install.configPatch`.** When the app's wrangler config needs a change before it
  installs from its pinned commit, open a pull request upstream first. Until it is
  merged, the entry may carry the change as a JSON merge patch (RFC 7386: an object
  merges key by key, `null` removes a key, an array replaces the whole list), with a
  comment linking the pull request:

  ```jsonc
  "install": {
    // Until https://github.com/<owner>/<repo>/pull/<number> is merged.
    "configPatch": { "build": null, "vars": { "DEBUG": null } }
  }
  ```

  After the build commands, the packer writes the patched config beside the original as
  `.appflare.wrangler.jsonc`, so relative paths resolve as before, bundles from it,
  and prints each change in the pack log. A TOML config is patched the same way and
  written as JSONC. A build command that reads the wrangler config itself still sees
  it unpatched. Only these keys may be patched: `main` and `assets`, with paths
  relative to the config and without `..`; `build`, only
  to `null` when `install.buildCommand` builds instead; `services`, only to leave
  bindings out or to add one that points at a Worker of the same entry;
  `kv_namespaces`, `r2_buckets` and `d1_databases`, only to add bindings or to leave
  out an `id`, `bucket_name` or `database_id` that is an empty string or a
  placeholder the upstream deploy script fills (`$NAME`, `${NAME}`, `{{NAME}}`,
  `<NAME>`), so the install provisions it; `vars`, only removals; and `migrations`, only to rename
  `new_classes` to `new_sqlite_classes`, which the Free plan requires; `ratelimits`,
  only to add a rate limit an upstream deploy script adds, keeping the config's own. A section
  Appflare cannot install may be set to `null` to drop it, when the app works without
  it (`"vpc_services": null`, `"unsafe": null`). Anything else fails with a message. An app of several Workers sets `configPatch` on each Worker
  in `install.workers`. The patch is part of the signed manifest.
  `appflare-pack inspect <checkout> --config <config> --manifest appflare.jsonc`
  applies it and shows what changed.
- **`install.wranglerConfigInline`.** When the repository commits no wrangler config
  at all (its deploy script writes one, or it relies on wrangler's automatic setup),
  open a pull request upstream that adds one. Until it is merged, the entry may carry
  the config itself, with a comment linking the pull request, and set `wranglerConfig`
  to where the packer writes it: `.appflare.wrangler.jsonc` at the root, or
  `<directory>/.appflare.wrangler.jsonc` for a Worker that lives in a directory of the
  repository. Relative paths in the config resolve from that directory.

  ```jsonc
  "install": {
    "wranglerConfig": ".appflare.wrangler.jsonc",
    // Until https://github.com/<owner>/<repo>/pull/<number> is merged.
    "wranglerConfigInline": {
      "main": "server/src/index.ts",
      "compatibility_date": "2026-01-20",
      "assets": { "directory": "./dist/client", "binding": "ASSETS" },
      "d1_databases": [{ "binding": "DB" }],
      "triggers": { "crons": ["*/20 * * * *"] }
    }
  }
  ```

  The packer writes it before installing dependencies, with the install's Worker name
  as `name`, and reads it like a config of the repository's. It may set only `main`,
  `compatibility_date` (required), `compatibility_flags`, `assets`, `vars`,
  `triggers`, `observability`, `placement`, `kv_namespaces`, `r2_buckets` and
  `d1_databases` without ids (the install provisions each), `queues`,
  `durable_objects` bindings to classes its own `migrations` create in
  `new_sqlite_classes`, `workflows` and `services` without a `script_name`, and the
  `ai`, `browser`, `images` and `version_metadata` bindings. A service binding to
  another Worker of the entry names it as the install does: the primary Worker by
  `install.workerName`, any other as `<workerName>-<name>`. The pack fails when the
  repository has a config of its own in that directory (patch that one instead), or
  when a build leaves a redirect to a config it generated there. The config cannot sit
  beside a `configPatch`; an app of several Workers sets it on each Worker in
  `install.workers`. The packer never runs wrangler's automatic configuration (what
  `wrangler deploy` does in a project without a config): it changes `package.json`
  and adds dependencies, so the install would no longer match the lockfile.
- **Package manager versions.** The packer reads which version the repository
  expects from its `package.json` (the nearest one at or above each install
  directory). yarn 2 or later must be pinned with `"packageManager": "yarn@4.x.y"`; it
  installs with `corepack yarn install --immutable --mode=skip-build` and
  `YARN_ENABLE_SCRIPTS=false`, since yarn 2 refuses classic yarn's flags, and
  corepack fetches the pinned yarn. A repository with a `.yarnrc.yml` but no such pin
  fails the pack: corepack would run classic yarn, which would run install scripts.
  npm installs with the npm that ships with Node.js 22 (npm 10), unless
  `"packageManager": "npm@11.x"` or `engines.npm` asks for a later major; npm 11 runs
  as `npx --yes npm@11.20.0 ci --ignore-scripts`, an exact release. A
  `package-lock.json` of `lockfileVersion` 3 that npm 10 refuses as out of sync
  ("Missing: … from lock file"), as it does with some lockfiles npm 11 wrote, is
  installed again with npm 11, and the log says so.
- **What runs at install.** Install scripts are off, but that does not keep the
  repository's own code out of the install: `npx` can resolve a binary from the
  checkout's `node_modules`, and a `yarnPath` in `.yarnrc.yml` runs the yarn release
  file committed to the repository. The build commands run the repository's code
  anyway, which is why the pack runs without credentials.
- **`install.toolchains`.** Set `["rust"]` for a workers-rs app whose build runs
  `worker-build`: catalog CI then installs a pinned Rust toolchain with the
  `wasm32-unknown-unknown` target before the pack. Only the `artifact` tier takes
  it; an app that needs Rust cannot be built in an account's sandbox Worker, whose
  image has no Rust.
- **Worker size.** `pnpm pack-app` prints each Worker's modules, the Range requests
  the manager reads them with, and their size, for example
  `579 modules in 2 ranges, 11.44 MiB of at most 32.00 MiB`. Cloudflare accepts a
  Worker of up to 64 MiB uncompressed on every plan; the manager uploads at most
  32 MiB of modules in one request, and packing fails above that. The number of
  modules is not limited.
- **`install.wranglerConfig`.** Name the app's own wrangler config, the one you would
  run `wrangler deploy` next to. When the build leaves `.wrangler/deploy/config.json`
  beside it, as the Cloudflare Vite plugin does, the packer follows that redirect to
  the config the build generated, exactly as `wrangler deploy` does, and records both
  paths in the artifact. Do not point `install.wranglerConfig` at the generated config
  itself: wrangler then reads it as a hand-written config and refuses fields that
  build tools write, such as `legacy_env`. When the repository keeps its config only
  as a template, such as `wrangler.toml.example` or `wrangler.jsonc.template`, name
  the template: the packer copies it to its real name (`wrangler.toml`) beside itself
  before the build runs and wrangler reads it. A real file of that name already in
  the repository must be identical to the template, or the pack fails.
- **Databases elsewhere.** An app that keeps its data in PostgreSQL or MySQL outside
  Cloudflare binds it through Hyperdrive. Declare each Hyperdrive binding of the
  wrangler config under `resources.hyperdrive`, for example
  `"resources": { "hyperdrive": [{ "binding": "HYPERDRIVE", "protocol": "postgres", "label": "Main database" }] }`,
  with an optional `help` sentence. The install form then asks for a connection
  string per binding (`postgres://user:password@host:5432/database`, or `mysql://`),
  and the manager creates a Hyperdrive configuration of the install's own from it,
  named `<worker name>-<binding>`. The packer refuses a Hyperdrive binding the
  manifest does not declare, and a declaration the config does not bind. The
  database is the admin's: an uninstall deletes the Hyperdrive configuration, never
  the database. Self-deploying entries cannot declare databases.
- **Streams (Pipelines).** A stream's id in the wrangler config
  (`"pipelines": [{ "binding": "EVENTS", "stream": "<id>" }]`) belongs to the author's
  account, so describe the stream under `resources.pipelines`, keyed by the binding:
  `"resources": { "pipelines": { "EVENTS": { "schema": { "fields": [{ "name": "ts", "type": "timestamp", "required": true }] }, "sink": { "type": "r2_data_catalog", "bucket": "WAREHOUSE", "namespace": "app", "table": "events", "tokenSecret": "CATALOG_TOKEN", "rollIntervalSeconds": 60, "compaction": true } } } }`.
  The manager creates the stream (`<worker_name>_<binding>_stream`, schema as given,
  no HTTP endpoint), an R2 Data Catalog sink that writes to `namespace.table`, and a
  pass-through pipeline (`INSERT INTO <sink> SELECT * FROM <stream>`), and binds the
  stream. `bucket` names an R2 binding of the app, or any other name for a bucket of
  the install's own (`<worker name>-<name>`), which no Worker binds; a var such as
  `"{{workerName}}-warehouse"` tells the app its name. `tokenSecret` names a secret
  the form asks for (no `generate`, `optional`, `derive` or `seedOnly`): an R2 API
  token with Admin Read & Write, which Cloudflare keeps as the sink's credential and
  which the app may also use for R2 SQL. `compaction` and `snapshotExpiration`
  (`{ "maxAge": "30d", "minSnapshotsToKeep": 5 }`) turn on the catalog's table
  maintenance. Pipelines is on Workers Paid only, so the entry needs `"plan": "paid"`.
  Streams, sinks and pipelines cannot be changed once created: a new version that
  changes the schema or the table keeps what the install created, and a version that
  adds a stream needs a fresh install. The packer refuses a Pipelines binding the
  manifest does not describe, and a description the config does not bind.
  Self-deploying entries cannot declare streams.
- **D1 SQL outside the migrations folder.** The packer reads each D1 binding's
  `migrations_dir` and `migrations_pattern` as `wrangler d1 migrations apply` does,
  relative to the config you name in `install.wranglerConfig`. When the app's D1 SQL
  is elsewhere, say where under `resources.d1`, keyed by the D1 binding, with paths
  relative to the repository's root:
  `migrationsDir` for another folder of migrations; `migrations` for a glob such as
  `prisma/migrations/*/migration.sql`, which works as wrangler's `migrations_dir`
  (the folder before the first `*`) plus `migrations_pattern`, so each file is
  recorded as wrangler records it (`20240101_init/migration.sql`) and they run in
  wrangler's order; `schema` for SQL files that run on every
  install and update after the migrations (the packer accepts them only when every
  CREATE TABLE, INDEX, TRIGGER and VIEW says `IF NOT EXISTS`, nothing is dropped or
  altered, and rows are only added when missing, with `INSERT OR IGNORE` or
  `ON CONFLICT DO NOTHING`; `UPDATE`, `DELETE` and other inserts are refused); and
  `postDeployMigrationsDir` for migrations that must wait until
  the new version serves all traffic. Migrations and post-deploy migrations are
  recorded in `d1_migrations` by file name, so their names must differ. A rollback
  reverts neither. For example
  `"resources": { "d1": { "DB": { "schema": ["src/db/schema.sql"] } } }`. A schema
  file creates what is missing and nothing more: `CREATE TABLE IF NOT EXISTS` never
  adds a column to a table that already exists, so when upstream changes a table in
  its schema file, installs made before the change keep the old table. Changing an
  existing table needs a migration.
- **A full schema file with migrations for older databases.** Some apps keep their
  whole current schema in one file (plain `CREATE TABLE`, default rows) and their
  migrations only bring databases made by older versions up to date, so the
  migrations fail on an empty database. Name that file as the binding's `baseline`:
  `"resources": { "d1": { "DB": { "baseline": "db/schema.sql" } } }`. On install,
  the baseline runs once on the new database, before the migrations, in one D1 query
  that also records every migration and post-deploy migration of that version in
  `d1_migrations` as applied, so none of them runs there. The baseline runs only on an
  empty database (no tables of the app's, nothing in `d1_migrations`), so updates never
  run it on a database the install already has; they apply only the migrations added
  after the installed version, as for any app. A database an update creates for a new
  binding gets its baseline, since it starts empty. The baseline need not be
  safe to run twice, but it may not `ATTACH`, `DETACH` or `DROP DATABASE`, set a
  PRAGMA (`PRAGMA defer_foreign_keys` is allowed), open or end a transaction, or name
  `d1_migrations` or a `sqlite_` or `_cf_` table (even in quotes), or end inside an
  unclosed comment or string, and it must create at least one table that is not
  temporary. A binding has a baseline or `schema` files, not both. This works only while
  upstream keeps the baseline in step with its migrations: an install gets the
  baseline as it is at the pinned commit and never the migrations of that commit, so
  a column a migration adds must also be in the baseline. Check that when you submit
  the entry and when you move its pin.
- **`secrets` and `vars`.** List every secret and setting the app reads from `env`
  that is not in its wrangler config. Use `"generate": true` for passwords and
  signing keys the user does not need to choose. List a var from the wrangler config
  too when admins should be able to change it; without a `default`, the form starts
  with the wrangler config's value. The secrets the wrangler config lists in
  `secrets.required` belong here too; the pack names any it finds missing.
- **A secret the wrangler config sets as a var.** Some apps ship a placeholder
  password in `vars`. Declare the name as a secret: the packer then leaves the var
  out of the artifact and logs `var <NAME> is provided as a secret`, since a Worker
  cannot have a var and a secret of one name. Never declare one name both as a
  secret and as a var in `appflare.jsonc`; the pack refuses that.
- **Derived secrets.** When the app wants a hash of a password rather than the
  password, as Counterscale's `CF_PASSWORD_HASH` is a bcrypt hash, list the password
  as a secret and the hash as a second one with
  `"derive": { "from": "CF_PASSWORD", "method": "bcrypt" }`. The install form asks
  only for the password; the manager computes the hash (bcrypt, cost 10) and sets
  both, and again whenever the password gets a new value. The source must be an
  ordinary secret of the same manifest, neither optional nor derived, and a derived
  secret cannot be `generate` or `optional`. Self-deploying entries cannot derive
  secrets.
- **Web Push (VAPID) keys.** For an app that sends push notifications, give the
  private key secret `"generate": "vapid-private-key"`: the install form fills in a
  new P-256 private key, as the unpadded base64url of its 32 raw bytes (the format
  `web-push` and similar libraries take), and the manager refuses a value that is
  not one. Declare the public key as a var with
  `"derive": { "from": "VAPID_PRIVATE_KEY", "method": "vapid-public-key" }`: the
  manager computes it (the unpadded base64url of the 65-byte uncompressed point)
  at install and whenever the private key gets a new value, and the install and
  settings forms show it read-only. A derived var has no `default`, `type`,
  `options` or `required: true`, and its source is a `vapid-private-key` secret of
  the same manifest that is not optional. The same `derive` works on a secret, for
  an app that reads the public key as one. Self-deploying entries cannot derive vars.
- **Raw 256-bit keys.** For an app that reads an encryption key as base64 of 32
  bytes (it runs `atob` and expects 32 bytes back), give the secret
  `"generate": "base64-key-32"`: the install form fills in 32 random bytes as padded
  base64 (44 characters), and the manager refuses a value that does not decode to
  32 bytes.
- **Multi-line secrets.** For a value of several lines, such as a PEM private key
  (a GitHub App's `GITHUB_APP_PRIVATE_KEY`), add `"multiline": true`. The install,
  update and settings forms ask for it in a monospace text area instead of a
  one-line password field, which would drop the line breaks. The Worker gets the
  value as pasted: Windows line endings become `\n` and spaces or tabs at the end
  of the last line are dropped; every other character, line breaks included, is
  kept. A text area cannot hide its text, so the value shows while the admin enters
  it and cannot be read back once saved. A multi-line secret cannot be `generate` or
  `derive`. An artifact whose manifest has one is format 5, so a manager too old to
  know the field refuses it rather than ask for the value on one line.
- **A first admin.** An app that has no sign-up page and expects its first admin
  account in the database can have Appflare add it at install. See
  [Seeding a first admin](#seeding-a-first-admin).
- **Optional secrets.** Add `"optional": true` to a secret the app works without,
  such as an SMTP password for a feature that stays off until it is set. The install
  form leaves it unset unless the admin chooses **Set it now**, updates never ask for it,
  and admins can set or remove it later in the app's settings. Self-deploying entries
  cannot have optional secrets: their installer runs with every secret the manifest
  lists.
- **Choices.** A var that takes one of a few fixed values can say so with
  `"type": "select"` and `"options"`, a list of `{ "value", "label" }` in the order
  the form shows them (2 to 20, with distinct values). The form shows cards for up to
  four options and a dropdown for more. `default`, when given, must be one of the
  values. For a var the app reads as JSON, each value is JSON text, such as `"true"`.
  `HOME_PAGE` in the example above is one.
- **Placeholders.** The manager replaces `{{workerUrl}}` (the install's workers.dev
  URL, without a trailing slash) and `{{workerName}}` (its Worker name) in
  `postInstall` text, in `vars[].default`, and in the values of the wrangler config's
  own `vars`. Use them for apps that need their public URL in a variable, for example
  `{ "name": "PUBLIC_URL", "label": "Public URL", "default": "{{workerUrl}}" }`.
  `{{accountId}}` becomes the id of the account the app is installed in, for apps
  that query the Cloudflare API about their own account, such as the
  Analytics Engine SQL API. `{{wildcardHostname}}` becomes the hostname of the
  app's [wildcard domain](/guides/custom-domains/#wildcard-domains) (no scheme, such
  as `tunnels.example.com`) for an entry with `install.wildcardHostname`, and is
  empty until the admin assigns one; assigning or removing it deploys the settings
  again, so the var follows the domain. Vars are filled in again on every update and
  settings change. `{{workerUrl}}` is always the
  workers.dev address, even when a custom domain is attached to the install. An
  [app of several Workers](#apps-of-several-workers) can also name each of its
  Workers.
- **JSON vars.** A wrangler config var whose value is not a string (an array, object,
  number, or boolean) reaches the Worker as that JSON value, as with `wrangler
  deploy`. When `vars` lists such a var, its `default` must be JSON text, such as
  `"[\"inbox@example.com\"]"`, and the install form asks for JSON.
- **`requires`.** List account features the app needs beyond Workers, such as `r2`
  or `workers-ai`.
- **`tokenPermissions`.** Only for apps that call the Cloudflare API with a token of
  their own.
- **`authors`.** Who wrote the app upstream, shown on the catalog card and the app
  page: one or more `{ "name", "url"?, "github"?, "x"? }`, with handles written
  without `@`. Optional; without it the catalog lists the owner of `repo`. Changing
  only `authors` needs no new release: the catalog index reads it from the manifest.
- **`maintainers`.** At least one GitHub username: the people who package the app
  for the catalog, shown as **Packaged by** on the app page. See
  [CODEOWNERS](#codeowners).
- **`bump`.** Optional. `"bump": { "autoMerge": true }` lets version bumps merge
  themselves once their checks pass. See [Version bumps](/catalog/bumps/#auto-merge).
- **`revision`.** Optional; leave it out for a new app. Raise it to publish a change
  to the form or copy of a version that is already released. See
  [After merge](#after-merge).

Every field is described in the [manifest reference](/catalog/manifest-reference/).
Add an optional `apps/<slug>/README.md` for notes.

## Static sites without Worker code

A wrangler config with `assets` and no `main` is a Worker that only serves its static
assets, and Appflare installs it the way `wrangler deploy` uploads one: the artifact
carries the assets and no Worker modules, and the manager uploads the Worker with its
assets and compatibility settings alone. A build that writes the asset directory runs
as usual, from the config's `build.command` or `install.buildCommand`; a repository
without a `package.json` sets `"installDirs": []`.

Such a Worker has no code to use anything else, so the pack fails when it has
bindings (`vars` included), catalog `secrets` or `vars`, Durable Objects, cron
triggers, queue consumers, an `assets.binding`, or `assets.run_worker_first`.
Observability, placement, limits and `cache` settings are left out, as wrangler
leaves them out, and the pack log says so. The health check requests `healthPath`
(default `/`) as for any app, so the site should answer there. When the asset
directory is the repository root, it needs an `.assetsignore` that leaves out
everything that is not part of the site (`.git`, `.wrangler`, the wrangler config),
as `wrangler deploy` would upload it too. Such an artifact is written in format 5,
which an earlier version of Appflare refuses with a message to update it first.

## Seeding a first admin

Some apps store their users in D1 and only let an existing admin create others,
so upstream tells you to insert the first admin by hand, or ships a seed file with
a default password. A catalog entry can instead have Appflare insert that row once,
at install, from values the admin enters in the install form. Declare it under
`resources.d1[binding].seed`:

```jsonc
"secrets": [
  { "name": "ADMIN_PASSWORD", "label": "Admin password", "generate": true, "seedOnly": true }
],
"vars": [
  { "name": "ADMIN_USERNAME", "label": "Admin user name", "required": true, "seedOnly": true }
],
"resources": {
  "d1": {
    "DB": {
      "schema": ["worker/schema.sql"],
      "seed": {
        "hashes": {
          "admin": {
            "from": "ADMIN_PASSWORD",
            "method": "pbkdf2-sha256",
            "iterations": 100000,
            "saltBytes": 16,
            "keyBytes": 32,
            "encoding": "base64url"
          }
        },
        "statements": [
          {
            "sql": "INSERT OR IGNORE INTO users (username, password_hash, password_salt, is_admin) VALUES (?, ?, ?, 1)",
            "params": [{ "var": "ADMIN_USERNAME" }, { "hash": "admin" }, { "salt": "admin" }]
          }
        ]
      }
    }
  }
}
```

- **Statements.** Each is exactly one `INSERT OR IGNORE`, or one `INSERT ... ON
  CONFLICT ... DO NOTHING`, so a retried step keeps the row the first attempt added.
  `WITH`, `DO UPDATE`, other statement kinds (`CREATE`, `UPDATE`, `DELETE`, `PRAGMA`,
  `ATTACH` and the like), and the `d1_migrations`, `sqlite_` and `_cf_` tables are
  refused. At most 10 statements per binding.
- **Params.** Values are never written into the SQL. Put an anonymous `?` wherever a
  value goes and list one param per `?`, in order (at most 20): `{ "var": NAME }` or
  `{ "secret": NAME }` for a var or secret of the manifest, `{ "hash": ID }` or
  `{ "salt": ID }` for a hash of `hashes`, or `{ "value": "text" }` for literal text.
  D1 binds them. Numbered (`?1`) and named (`:name`) parameters are refused, as is a
  count of `?` that differs from the params.
- **Hashes.** Hash a password the way the app checks it. `pbkdf2-sha256` takes
  explicit `iterations` (at most 100,000, the most Cloudflare Workers derive),
  `saltBytes` and `keyBytes` (16 to 64) and an `encoding` for both the hash and the
  fresh random salt: `base64url` (unpadded), `base64` or `hex`. `bcrypt` gives a
  `$2b$` hash with its salt inside, at `cost` 10 unless you set 4 to 10; a bcrypt
  source longer than 72 bytes is refused at install, since bcrypt ignores the rest.
  Each hash is computed once per install, so a hash and its salt match. Its `from`
  must be a secret of the manifest, neither optional nor derived.
- **Seed-only values.** `"seedOnly": true` on a secret or var means it exists for the
  seed alone: the install form asks for it once and says so, and it is never set on
  the Worker, stored in the app's settings, or asked for again by updates or
  settings. Use it for the admin's password, so the plaintext never sits in the
  app's environment. A generated seed-only password is shown once more, with a copy
  button, on the install's job page. A seed-only value must be used by a seed, cannot
  be optional, derived or limited to some Workers, and no derived value may come
  from it. A var a seed uses must be required, have a default, or be derived. Name
  the user in `postInstall`, never the password.
- **When it runs.** Only the install job seeds, after the binding's migrations,
  schema files and post-deploy migrations. With `"beforeSchema": true` it runs
  before the schema files instead, so the seeded row wins over a default row a
  schema file adds with `INSERT OR IGNORE` (claim the default admin's user name, and
  the upstream default password never lands). Updates never run a seed, even a
  changed one, and never ask for seed-only values. A rollback restores the Worker
  only.
- **What it cannot protect.** If an upstream schema file inserts a default admin and
  the seeded row is later deleted, the next update's schema file adds the default
  again. Say so in the app's `README.md`, and prefer an upstream change that drops
  the default row.

Seeds are not allowed on self-deploying entries. An artifact with a seed is format
4, which older managers refuse with a message to update Appflare instead of
installing the app without its first admin.

## Apps of several Workers

Some apps are more than one Worker, such as a web front end and an API, or an app
that serves uploaded files from an origin of their own. List every Worker in
`install.workers`, and the manager installs, updates, and uninstalls them together
as one app:

```jsonc
"install": {
  "tier": "artifact",
  "packageManager": "pnpm",
  "wranglerConfig": "apps/web/wrangler.jsonc",
  "workerName": "notes",
  "buildCommand": "pnpm run build",
  "workers": [
    { "name": "web", "wranglerConfig": "apps/web/wrangler.jsonc", "primary": true },
    { "name": "api", "wranglerConfig": "apps/api/wrangler.jsonc" }
  ]
},
"secrets": [
  { "name": "SESSION_SECRET", "label": "Session secret", "generate": true, "workers": ["web"] },
  { "name": "API_KEY", "label": "API key", "generate": true }
],
"vars": [{ "name": "API_URL", "label": "API URL", "default": "{{workerUrl:api}}" }]
```

- **Two to 24 Workers**, on the artifact tier only. Each has a `name` within the
  entry: up to 24 lowercase letters, digits, and hyphens, not starting or ending
  with a hyphen. Each wrangler config must have a `name` of its own.
- **Workers Free takes at most three.** The manager installs and updates all of an
  app's Workers in one job, and each Worker adds requests to it; the free plan
  allows 50 per job. An entry of four or more Workers must set `"plan": "paid"`;
  the schema refuses it otherwise. On Workers Paid a job may make 10,000 requests and run
  10,000 steps, and each Worker's upload runs in a request of its own, so 24 Workers
  fit with room to spare; the manager totals the job's steps before it starts and
  refuses a job that would not fit.
- **Every Worker counts toward the account's limit**: 100 Workers on Workers Free,
  500 on Workers Paid. The install counts the account's Workers first and stops
  before creating anything when the app's Workers would not fit.
- **Exactly one is `primary`.** It is the app: it runs under the install's Worker
  name and serves the app's address, its custom domains, and the health check
  (`install.healthPath` is a path on it). Its `wranglerConfig` must equal
  `install.wranglerConfig`, so tools that build one Worker build the primary. Every
  other Worker runs as `<install Worker name>-<name>` on its own workers.dev
  address: `notes-api` in the example.
- **Workers only the app calls.** Set `"workersDev": false` on a Worker that only the
  entry's other Workers reach, through a service binding or a Durable Object binding,
  and that must not answer from the internet: for example one that trusts identity
  headers the primary Worker sets. The manager keeps its workers.dev URL and its
  version previews off on every install, update, rollback and settings change, skips
  its preview check during updates, and the app's page lists it as not reachable
  from the internet. Leave it out for every Worker that people or other services
  call, such as a file origin, an inbox, or a webhook endpoint. The primary Worker
  cannot set it: it is the app's address and health check until the admin adds a
  custom domain, which turns its workers.dev URL off anyway. `{{workerUrl:<name>}}`
  of such a Worker is refused, since it has no URL. Managers too old to know the
  field refuse the release and ask the admin to update Appflare first.
- **Builds.** `install.buildCommand` runs once, first. Then each Worker's own
  `buildCommand`, if it has one, runs in the order of the list. Both follow the
  rules for `install.buildCommand` above.
- **Secrets and vars.** A secret's or var's `workers` lists the Workers that get it.
  Without it, a secret goes to every Worker, and a var goes to the Workers whose
  wrangler config declares it, or to every Worker when none does.
- **Placeholders.** `{{workerUrl:<name>}}` and `{{workerName:<name>}}` give one
  Worker's workers.dev URL and installed Worker name (`{{workerUrl:<name>}}` only for
  a Worker on workers.dev). `{{workerUrl}}` and
  `{{workerName}}` still mean the app, that is, the primary Worker.
- **Resources are shared by binding name.** Workers that both bind `DB` use one D1
  database, so they must bring the same migrations, or only one of them brings any.
  A queue one Worker sends to and another consumes is one queue. Bindings of one
  name must be of one type and declared alike.
- **Bindings between the Workers.** A service binding whose `service` is another
  Worker's wrangler `name`, and a Durable Object binding whose `script_name` is,
  are pointed at that Worker as installed. Durable Objects may live in any of the
  Workers. Each Worker is deployed after the Workers it binds to, with the primary
  as late as possible.

The pack fails on a service binding to any Worker outside the entry, on Workers that
bind each other in a cycle, on a Workflow bound from a Worker other than the one
that defines it, and on one D1 binding with different migrations in two Workers.

## 2. Open a pull request

Commit messages follow Conventional Commits, for example `feat(apps): add cut`.

The pull request runs these checks:

1. The manifest is validated against the schema, and `CODEOWNERS` must match the
   manifests.
2. The app is packed from the pinned commit exactly as a release would be, and every
   file's hashes are verified. Packing fails if a Worker is too large for the
   manager to upload in one request.
3. **The install check.** The packed app is deployed to a dedicated Cloudflare test
   account with random secrets and default settings. CI then requests its health
   path for up to 60 seconds, and deletes everything again. A server error, or no
   answer at all, fails the check. A plain 404 at the end passes.

Pull requests from forks get no CI secrets. The checks build the packer from the
appflare/appflare repository, which is private until launch and needs a secret to
read, so a pull request from a fork fails the `verify` check until that repository
is public.

## CODEOWNERS

`CODEOWNERS` is generated from each manifest's `maintainers`: one line
`/apps/<slug>/ @user …` per app. Maintainers review changes to their app,
including [version bumps](/catalog/bumps/). Regenerate it with `pnpm gen-codeowners`
in the catalog checkout and commit the result; CI fails if it is out of date.

## After merge

Merging to `main` publishes the app: CI packs it again, signs it, creates the
release `<slug>@<version>`, and adds it to `index.json`. Managers pick it up at their
next catalog refresh, within 30 minutes.

To change a published app's manifest, re-pin `source` in the same pull request.
A change to a released version without a new pin fails to publish, with two
exceptions:

- a change to `authors` alone, which `index.json` reads from the manifest;
- a change to the form or copy only (`name`, `summary`, `tagline`, `homepage`, `license`,
  `categories`, `maintainers`, `secrets`, `vars`, `postInstall`, `bump`) together
  with `revision` raised by one (it starts at 1 when omitted). CI signs and
  publishes the revised manifest without building anything; managers switch to the
  new form without an update. Anything else, such as `install`, `requires`, `plan`
  or `tokenPermissions`, changes what gets built or provisioned and needs a new pin.
  Once a revision is published, any further change to the manifest, `authors`
  included, needs the next revision.
