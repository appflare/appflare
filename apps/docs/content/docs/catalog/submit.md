---
title: Submit an app
description: Add an app to the Appflare catalog with one manifest file and a pull request.
---

Adding an app takes one file, `apps/<slug>/appflare.jsonc`, in a pull request to
[appflare/catalog](https://github.com/appflare/catalog). You do not need to change the
app's own repository.

## Before you start

- **The app needs a public repository and a license.**
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
  call another app or Appflare itself.
- **The Worker has at most 21 modules.** The manager installs apps from inside a
  Workflow on the free plan, which allows 50 subrequests per invocation, and it
  fetches each module as its own subrequest. A build that code-splits into many
  chunks must be configured to emit one module.
- **It fits the free plan, or says it does not.** A Worker larger than 3 MB
  compressed, or one that needs paid features, is `"plan": "paid"`.

The manager creates KV namespaces, D1 databases, R2 buckets, queues, and Vectorize
indexes for an app, attaches the app's Worker to the queues it consumes (dead-letter
queues included), and passes through Workers AI, Browser Rendering, Analytics Engine,
email sending (with its address restrictions), rate limits, Images, version metadata,
and plain variables. A service binding to the app's own Worker is pointed at the
installed Worker, whatever name it is installed under; set `install.fixedWorkerName`
only when something else in the app needs one fixed name. Other binding types cannot
be installed yet.

The catalog's install check is stricter for now. It rejects apps with queue,
Hyperdrive, service, mTLS certificate, or email bindings, so such an app cannot pass
its pull request checks yet, even where the manager could install it.

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
      "help": "default, 404, or admin",
      "required": false
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
  and before bundling. It runs without a shell and without credentials, with the
  repository's `node_modules/.bin` on its PATH, so pipes, redirects, quotes,
  variables, and `NAME=value` assignments are refused.
- **`install.wranglerConfig`.** Name the app's own wrangler config, the one you would
  run `wrangler deploy` next to. When the build leaves `.wrangler/deploy/config.json`
  beside it, as the Cloudflare Vite plugin does, the packer follows that redirect to
  the config the build generated, exactly as `wrangler deploy` does, and records both
  paths in the artifact. Do not point `install.wranglerConfig` at the generated config
  itself: wrangler then reads it as a hand-written config and refuses fields that
  build tools write, such as `legacy_env`.
- **`secrets` and `vars`.** List every secret and setting the app reads from `env`
  that is not in its wrangler config. Use `"generate": true` for passwords and
  signing keys the user does not need to choose. List a var from the wrangler config
  too when admins should be able to change it; without a `default`, the form starts
  with the wrangler config's value.
- **Placeholders.** The manager replaces `{{workerUrl}}` (the install's workers.dev
  URL, without a trailing slash) and `{{workerName}}` (its Worker name) in
  `postInstall` text, in `vars[].default`, and in the values of the wrangler config's
  own `vars`. Use them for apps that need their public URL in a variable, for example
  `{ "name": "PUBLIC_URL", "label": "Public URL", "default": "{{workerUrl}}" }`.
  Vars are filled in again on every update. `{{workerUrl}}` is always the
  workers.dev address, even when a custom domain is attached to the install.
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

Every field is described in the [manifest reference](/catalog/manifest-reference/).
Add an optional `apps/<slug>/README.md` for notes.

## 2. Open a pull request

Commit messages follow Conventional Commits, for example `feat(apps): add cut`.

The pull request runs these checks:

1. The manifest is validated against the schema, and `CODEOWNERS` must match the
   manifests.
2. The app is packed from the pinned commit exactly as a release would be, and every
   file's hashes are verified. Packing fails if the Worker has too many modules.
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
A metadata-only change to a released version fails to publish, except a change to
`authors` alone, which `index.json` reads from the manifest.
