# Add an app to the Appflare catalog: instructions for a coding agent

The user asked you to add an app to the Appflare catalog: write its catalog manifest,
check it with the catalog's own tooling, and open a pull request to
https://github.com/appflare/catalog. You run commands on their computer. Follow these
instructions exactly, in order.

You need two things from the user. If their message did not give them, ask for both
before anything else:

- the app's repository URL (the upstream project, on GitHub);
- their GitHub username, which becomes the entry's maintainer.

Read these first. Where they disagree with these instructions, they win:

- CONTRIBUTING.md of https://github.com/appflare/catalog
- https://appflare.dev/catalog/submit.md
- https://appflare.dev/catalog/manifest-reference.md

You need Node.js 22, pnpm, git, and the GitHub CLI (`gh`). No Cloudflare credentials:
packing an app never touches an account.

## Rules for the whole session

- The entry is one new folder, `apps/<slug>/`, plus the regenerated `CODEOWNERS`. Never change the app's own repository, other apps' folders, `index.json`, `schema/`, or the workflows. Never sign, release, or publish anything.
- Never print, paste, or ask the user for a token. No Cloudflare credentials are needed.
- Ask the user before anything that pushes to GitHub or opens a pull request.

## Steps

1. Check that the app qualifies. If it does not, stop and tell the user why.
   - A public GitHub repository. Any license qualifies, source-available ones and none at all included; the catalog shows the license, it does not decide on it.
   - Not a proxy, tunnel, or circumvention tool.
   - It deploys with wrangler: it has its own wrangler config (`wrangler.jsonc`, `wrangler.json`, or `wrangler.toml`).
   - It is self-contained: its own Worker defines its Durable Objects and Workflows, and its only service binding, if any, points at its own Worker.
   - No mTLS certificate bindings; the catalog's install check does not support them yet. A Hyperdrive binding (a PostgreSQL or MySQL database elsewhere) is fine when the manifest declares it under `resources.hyperdrive`.
   - If it has no wrangler project Appflare can read (it ships its own installer) or must be built in each user's account, read the sandbox and self-deploying tier sections of CONTRIBUTING.md and ask the user before going on. Those tiers need Workers Paid.
2. Run `gh auth status`. If the user is not logged in, ask them to run `gh auth login`. Ask them before forking. Then fork and clone the catalog, and create a branch named `add-<slug>`:
   ```sh
   gh repo fork appflare/catalog --clone
   ```
3. Set up the catalog's tooling, as CONTRIBUTING.md describes. Clone https://github.com/appflare/appflare next to the catalog checkout as `../appflare` (the repository is private until launch: use `gh repo clone appflare/appflare ../appflare` with the user's gh login, and if they have no access, stop and tell them), then, in the catalog checkout:
   ```sh
   git -C ../appflare checkout "$(cat .appflare-ref)"
   (cd ../appflare && pnpm install --frozen-lockfile && pnpm build)
   pnpm install
   ```
4. Choose the slug: short, lower case, the app's usual name, not already used in `apps/`. Pin the version: if the repository has stable semver tags, take the newest one; `source.ref` is the tag and `source.sha` the full 40-character commit it points to (for an annotated tag, the commit, not the tag object). Otherwise take the head of the default branch, with `source.ref` set to the branch name. When the tags do not describe this app, as in a repository of many templates, also set `source.version`.
5. Write `apps/<slug>/appflare.jsonc`, starting from a copy of `apps/cut/appflare.jsonc`. Read the app's wrangler config, README, `.dev.vars.example` if there is one, and the code that reads `env`. Fill in:
   - `$schema`, `slug`, `name`, `summary` (one sentence), `repo` (owner/name), `license`, `categories`. `homepage` (https) only when the app's website is not its GitHub repository.
   - `tagline` (required): what the app does in plain words for someone who is not a developer, one sentence of at most 80 characters with no trailing period, such as "Short links on your own domain".
   - `categories`: one to three ids from the fixed list in the manifest reference, such as `"utilities"`, `"productivity"` or `"analytics"`.
   - `license`: the SPDX license expression the repository declares, in current SPDX ids (MIT, Apache-2.0, GPL-3.0-only or GPL-3.0-or-later but never GPL-3.0, BUSL-1.1, FSL-1.1-MIT, ...); `NONE` when it publishes no license; `LicenseRef-<name>` with a `licenseNote` describing it for a license with no SPDX id. Never `NOASSERTION` or `SEE LICENSE IN <file>`, which a catalog entry cannot use. Add `licenseNote`, one short line, when the id does not say what matters, such as "Source-available: production use restricted; see the license".
   - `authors`: who wrote the app upstream, as the repository owner, its README, or its license names them. Each is `{ "name", "url"?, "github"?, "x"? }`, with handles written without @.
   - `maintainers`: the user's GitHub username, as a one-item list.
   - `install`: `packageManager` from the app's lockfile; `wranglerConfig`, the path of the app's own wrangler config (never a config a build generates; a template such as `wrangler.toml.example` is fine when the repository has no real config, and the packer copies it to its real name). Leave out `tier`, which defaults to `"artifact"`, and `workerName`, which defaults to the slug. Only when needed: `buildCommand`, a single command without shell syntax (or a list of such commands run in order, when the build has several steps or relies on a prebuild hook, which does not run), when the app needs a build step before `wrangler deploy` and its wrangler config has no `build.command`; `health`: `{ "path": "/api/health" }` with a path that answers, when `/` returns an error or needs a login, and `"mode": "any-response"` in it when every route sits behind a login or Cloudflare Access; `fixedWorkerName`, when the app only works under one Worker name; `installDirs`, when the dependencies to install are not (only) at the root, such as `[{ "path": "templates/blog" }]`, with `"lockfile": "none"` on a directory only when upstream ships no lockfile for it; `configPatch`, only when the wrangler config itself must change to install (an empty id, a service binding to a Worker outside the app, `new_classes` on the Free plan), after opening an upstream pull request with the same change and linking it in a comment beside the patch, or `null` for a config section Appflare cannot install that the app works without (such as `"vpc_services": null`); `wranglerConfigInline`, only when the repository commits no wrangler config at all, after opening an upstream pull request that adds one and linking it in a comment: the config itself (main, compatibility_date, assets, bindings without ids), with `wranglerConfig` set to `".appflare.wrangler.jsonc"` in the Worker's directory.
   - `plan`: `"paid"` when the app needs paid features, otherwise `"free"`. The Worker's size does not decide it.
   - `requires`: the account features it needs beyond Workers (`r2`, `workers-ai`, `zone`, `email-routing`, `browser-rendering`, `containers`, `analytics-engine`).
   - `resources.hyperdrive`: keyed by binding name, `{ "protocol": "postgres" | "mysql", "label"?, "help"? }` for each Hyperdrive binding of the wrangler config, when the app keeps its data in a database outside Cloudflare. The install form asks for its connection string.
   - `resources.pipelines`: for each Pipelines binding of the wrangler config, keyed by binding name, `{ "schema"?: { "fields": [...] }, "sink": { "type": "r2_data_catalog", "bucket", "namespace", "table", "tokenSecret", "rollIntervalSeconds"?, "compression"?, "compaction"?, "snapshotExpiration"? } }`. Set `plan` `"paid"`, and list the secret `tokenSecret` names (asked for, not generated): it holds an R2 API token with Admin Read & Write.
   - `secrets`: every secret the app reads that its wrangler config does not set, each with a label and help text; `"generate": "password"` for passwords and keys the user does not need to choose; `"optional": true` for one the app works without. When the app wants a bcrypt hash of a password, list the password and the hash, the hash with `"derive": { "from": "<password secret>", "method": "bcrypt" }`. When the app sends Web Push notifications, give its VAPID private key secret `"generate": "vapid-private-key"` and list the public key as a var with `"derive": { "from": "<private key secret>", "method": "vapid-public-key" }`. Give a secret whose value spans several lines, such as a PEM private key, `"multiline": true`.
   - `vars`: settings an admin should set or change. Every var needs a value unless it sets `"optional": true`. Use `{{appUrl}}` where the app needs the address people open it at (it follows a custom domain), `{{workerName}}` where it needs its Worker name, `{{accountId}}` where it needs the Cloudflare account id, and `{{wildcardHostname}}` where an app with `install.wildcardHostname` needs the hostname its sessions live under. Use `{{workerUrl}}` only when the app must name its workers.dev address even behind a custom domain.
     For an app that verifies Cloudflare Access's sign-in itself (the `Cf-Access-Jwt-Assertion` header), `{{accessTeamDomain}}` is the team domain (`<team>.cloudflareaccess.com`), `{{accessAud}}` the audience tag of the app's Access application, and `{{accessCertsUrl}}` the URL of the keys that sign the JWTs. They work only in a var's value (never in `postInstall` or a secret) and are empty while the app is not protected; turning protection on or off deploys the settings again.
   - `access`: optional. Appflare can protect any installed app with Cloudflare Access so only the manager's users reach it; the install form offers it switched off. Set `"mode": "required"` for an app with no sign-in of its own (it then installs only protected, only on accounts with a Zero Trust organization and a token with the Access permissions, and its protection cannot be turned off), or `"mode": "recommended"` to start the switch on. `"bypass"` lists up to 10 paths that stay public while protected, such as `["/s/*", "/api/webhook"]`: each starts with `/`, may end in `/*`, and has no other wildcard, query or fragment; do not list the health check path. With `"mode": "required"`, or a var default that uses an Access placeholder, also list `"access"` in `requires`, so managers too old to protect apps leave the entry out. Not for the self-deploying tier. Appflare's per-app service tokens are account service tokens, so a dashboard rule using "Any Access Service Token" also lets them in.
   - `postInstall`: what to do after installing, in Markdown (use `{{appUrl}}` for the app's address).
   - `tokenPermissions`: only if the app calls the Cloudflare API with a token of its own. Each entry is `{ "group", "scope", "access", "reason" }`, with `group` as the dashboard's token form names it, such as `{ "group": "DNS", "scope": "zone", "access": "edit", "reason": "Updates the DNS record for your home address." }`. Mark the secret that takes that token with `"cloudflareToken": true`.
   Leave out fields that only restate their default: `requires`, `secrets`, `vars`, `postInstall` and `tokenPermissions` when empty. The catalog's checks refuse any field the schema does not know, so a misspelled field is an error.
   - `resources.vectorize`: dimensions and metric for each Vectorize binding.

   Do not repeat bindings, compatibility settings, static assets, cron triggers, or migrations; the packer reads them from the wrangler config at the pin.
6. Check the entry, in the catalog checkout:
   ```sh
   pnpm validate <slug>
   pnpm pack-app <slug>
   pnpm gen-codeowners
   ```
   `pack-app` clones the app at the pin, installs its dependencies with install scripts disabled, and runs its build on this machine without credentials. It prints each Worker's modules and their size, which must be at most 32 MiB; any number of modules is fine. If a Worker is larger, or the build fails, stop and tell the user what the app would need to change. Do not commit the `dist/` directory `pack-app` writes.
7. Commit `apps/<slug>/` and `CODEOWNERS` with the message `feat(apps): add <slug>` and a body that says what the app is and why it belongs in the catalog. Check it with `pnpm exec commitlint --from origin/main`.
8. Show the user the manifest and ask them to confirm. Then push the branch to their fork and open the pull request with `gh pr create --repo appflare/catalog`. In its description, say what the app does, which tag or commit it is pinned to, what `validate` and `pack-app` reported, and anything you were unsure about.

## End with

The pull request's URL and a list of what is left for the user: the review on the pull request, and, as the entry's maintainer, reviewing its version bumps later (https://appflare.dev/catalog/bumps.md). Pull requests from forks get no CI secrets, so they fail the catalog's `verify` check until the appflare/appflare repository is public; if the pull request comes from a fork, say so in that list.
