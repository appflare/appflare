<!-- Relative paths render on GitHub. npm does not resolve them, so publishing to npm needs absolute image URLs here. -->
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../docs/assets/logo_full_white.svg">
    <img alt="Appflare" src="../../docs/assets/logo_full.svg" width="160">
  </picture>
</p>

# create-appflare / @appflare/cli

Installs [Appflare](https://github.com/appflare/appflare), a self-hosted app manager
for Cloudflare, into your own Cloudflare account, and lets you check on it, roll it
back, or remove it from the command line.

```sh
npx create-appflare
```

Appflare is not affiliated with Cloudflare.

## Requirements

- Node.js 22 or newer.
- A Cloudflare account. The installer runs `wrangler` (a dependency of this
  package, never a global one). If wrangler is not logged in, it opens
  `wrangler login` in your browser. You can also log in beforehand with
  `npx wrangler login`, or set `CLOUDFLARE_API_TOKEN` (and
  `CLOUDFLARE_ACCOUNT_ID`) in the environment.
- If your login can reach several accounts, the installer asks which one to use.
  Set `CLOUDFLARE_ACCOUNT_ID` to skip the question.

## Install

```sh
npx create-appflare [--version <x.y.z>] [--name appflare] [--yes]
```

1. Checks Node.js and your Cloudflare login, and picks the account.
2. Downloads the latest manager release (or `--version`) from
   `github.com/appflare/appflare/releases`: `appflare-<version>.zip`,
   `manifest.json`, and `manifest.sig`. It checks the Ed25519 signature against the
   public keys built into this package and the sha256 of every file. Nothing is
   deployed unless all of that passes.
3. Unpacks the manager into a temporary directory and deploys it with
   `wrangler deploy`.
4. Sets the manager's secret `BETTER_AUTH_SECRET` to a random value.
5. Prints the manager's address, `https://appflare.<your-subdomain>.workers.dev/`.
   Open it to finish setup: paste a Cloudflare API token for this account, then
   create the owner account. The address carries no secret; the token is the proof
   that you control the account. Only the address is written to stdout; progress
   goes to stderr.

The temporary directory is removed when the installer finishes, fails, or is
interrupted. Nothing is written to your current directory, no git repository is
created, and a wrangler config or `.env` in your current directory is ignored.

### What it creates in your account

| Resource | Name |
|---|---|
| Worker | `appflare` (or `--name`), on `workers.dev` with preview URLs |
| D1 database | same as the Worker name |
| KV namespace | `<name>-kv` |
| Workflow | `appflare-jobs` (`<name>-jobs` with `--name`) |
| Cron trigger | every 30 minutes |

The installer refuses to run if a Worker, D1 database, or KV namespace with those
names already exists.

On a new account without a `workers.dev` subdomain, wrangler asks you to register
one during the deploy. That needs a terminal and no `--yes`; otherwise register
the subdomain in the dashboard first.

### `--yes`

`--yes` means the installer never asks anything, and fails wherever it would have
asked:

- With several accounts and no `CLOUDFLARE_ACCOUNT_ID`, it stops instead of
  asking which account.
- `wrangler deploy` runs non-interactively (stdin closed, `--strict`). If the
  Workflow name already belongs to another Worker, the deploy aborts instead of
  asking whether to take it over. If the account has no `workers.dev`
  subdomain, the deploy fails instead of offering to register one.

Without `--yes`, in a terminal, you are asked in each of those cases.

### Options

| Flag | Meaning |
|---|---|
| `--version <x.y.z>` | Install release `manager@<x.y.z>` instead of the latest. |
| `--artifact-dir <dir>` | Use `manifest.json`, `manifest.sig`, and `appflare-<version>.zip` from `<dir>` instead of downloading. The signature is still required. |
| `--name <name>` | Worker name (default `appflare`). |
| `-y`, `--yes` | Never prompt; fail where a question would be needed (see above). |
| `--allow-unsigned` | Development only. Needs `APPFLARE_DEV=1` and `--artifact-dir`; accepts an artifact without `manifest.sig` and prints a warning. |
| `--no-telemetry` | Send no anonymous usage data, and install the manager with its usage data turned off (`APPFLARE_TELEMETRY=off`). Every command accepts it. |

`GITHUB_TOKEN`, if set, is sent to `api.github.com` when fetching releases and
downloading their files. Set it while the repository is private (for example
`GITHUB_TOKEN=$(gh auth token) npx create-appflare`), or to get around GitHub's rate
limits. Without access, GitHub answers 404, and the installer says the repository
may be private.

A release that was just published can take a few minutes to list all its files.
If the newest release is still incomplete, the installer installs the previous
complete release and prints a warning; run it again later for the newest one.

## Other commands

These run from the same package: `npx @appflare/cli <command>` (or
`npx create-appflare <command>`). They use wrangler and do not depend on the
manager's own UI working.

```sh
npx @appflare/cli status [--name appflare] [--url <url>]
```

Shows the active deployment, recent versions, the Appflare version that is
deployed, the result of `GET /api/health`, and whether an update is available
(`Update available: <version>` or `Up to date`, as of the manager's own last check
for releases). It finds the manager's URL by reading your account's `workers.dev`
subdomain with the credential wrangler already has; pass `--url` to skip that.

```sh
npx @appflare/cli rollback [--name appflare] [--list | --to <version-id>] [--yes] [--url <url>]
```

Redeploys an earlier version of the manager Worker (the previous deployment, or
`--to`). Asks for confirmation unless `--yes`. `--list` prints the recent versions
with their ids and dates, and changes nothing. After rolling back it checks
`GET /api/health` and prints the version the manager reports. Data in the manager's
D1 database is not rolled back.

```sh
npx @appflare/cli uninstall --yes [--name appflare] [--purge [--i-understand-data-loss]] [--url <url>]
```

Deletes the manager Worker, then its Workflow and the job history it holds
(Cloudflare keeps a Workflow when its Worker is deleted). Apps you installed with
Appflare are never touched: they keep running, and their resources stay. It first
checks that the Worker really is an Appflare manager (by its bindings, or by its
`/api/health` answer) and refuses otherwise, so an app that happens to have the
name is never removed or purged.

Without `--purge`, the manager's own D1 database and KV namespace stay; the command
lists them with the `wrangler` commands that delete them. With `--purge`, it also
deletes them, with all the manager's data (users, settings, install records, job
history). It deletes exactly the D1 database and KV namespace the manager Worker is
bound to, by id. If the Worker is already gone, it can only match by name: the D1
database named exactly `<name>` and the KV namespace titled exactly `<name>-kv`
(the names the installer gave them), and it tells you it is doing so. Before
deleting anything, it asks you to type the manager's name. It skips that question
only when `--yes --purge --i-understand-data-loss` are all given.

Here `--yes` only confirms the deletion. If your login can reach several accounts,
uninstall still asks which one, or set `CLOUDFLARE_ACCOUNT_ID` (required when it
runs without a terminal). It deletes the Worker even if other Workers depend on it.

### Sandbox builds (Workers Paid)

```sh
npx @appflare/cli sandbox enable [--version <x.y.z>] [--artifact-dir <dir>] [--yes]
npx @appflare/cli sandbox disable --yes [--purge [--i-understand-data-loss]]
```

`sandbox enable` deploys (or updates) the optional sandbox Worker,
`appflare-sandbox`, which builds sandbox tier apps from their pinned commit inside
Cloudflare Containers in your account. It comes from the signed release
`sandbox@<version>` (`appflare-sandbox-<version>.zip`, `manifest.json`,
`manifest.sig`), checked like the manager's, and is deployed with wrangler from a
temporary directory. It creates the Worker (no public URL), two container
applications running `docker.io/mendylanda/appflare-sandbox:<version>`, and the R2 bucket
`appflare-builds`. On a free account it stops with "Sandbox builds need Workers
Paid". `sandbox enable` needs an account on Workers Paid; both `sandbox enable` and
`sandbox disable` need either a login from `npx wrangler login` or an API token in
`CLOUDFLARE_API_TOKEN` that includes the Containers permission (Account > Containers >
Edit) in addition to Workers Scripts and Workers R2 Storage. Before downloading or
uploading anything, `sandbox enable` checks the account with the same read-only probes the
manager uses: the Workers plan (from the account's subscriptions, when the credential may
read billing), access to Containers, and whether R2 is enabled. When Cloudflare refuses Containers, the
error names the possible causes (the plan, and for an API token its permission) and how
to check each. A failed `sandbox enable` rolls back what it uploaded: the Worker when
the run created it, and the bucket when the run created it and it is empty. Each build
runs a `standard-1` container; a 10-minute build costs about US$0.012 beyond the usage
Workers Paid includes. After enabling it, open the manager's **Settings > Sandbox
builds** and choose **Connect sandbox builds**; sandbox tier and self-deploying apps
then install through it.

`sandbox disable --yes` deletes the Worker and its container applications and keeps
the bucket; `--purge` also empties and deletes the bucket after you type the
sandbox Worker's name (or with `--i-understand-data-loss`).

## Privacy

Appflare collects anonymous usage data to decide what to build and fix. It is on by
default, and the installer says so before it does anything else.

The installer sends one event when a command ends: which command it was, whether it
worked, how long it took, how far it got and an error category, the installer's
version, the operating system, CPU architecture and Node.js major version, whether it
ran in a terminal, in CI or under a coding agent, and whether the Worker name was the
default. It never sends your Cloudflare account id or name, the Worker name, email
addresses, domains, paths, your user name or hostname, or any error message. Events
go to PostHog Cloud's EU region and are tied to a random id, never to a person; the
PostHog project is set to discard IP addresses.

`create-appflare` deploys the manager with that random id as the variable
`APPFLARE_INSTALL_ID`, so the manager's own usage data continues it. The manager's
reports start with its first scheduled run after setup, and the last setup screen
says so; turn them off under Settings, Usage data. That switch covers the manager's
reports only, not the installer's.

Turn the installer's off with any one of:

- `--no-telemetry` on any command;
- `APPFLARE_TELEMETRY=off` (or `0`, `false`) or `DO_NOT_TRACK=1` in the environment.

With it off, the installer sends nothing and deploys the manager with
`APPFLARE_TELEMETRY=off`, which keeps the manager's usage data off for good (remove
the variable from the Worker to decide in Settings instead). Commands other than
install also send nothing for a manager that has the variable.

The installer also turns off wrangler's own usage metrics and error reports (which
would go to Cloudflare) for the commands it runs, unless you set
`WRANGLER_SEND_METRICS` or `WRANGLER_SEND_ERROR_REPORTS` yourself.
