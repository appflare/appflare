<!-- Relative paths render on GitHub. npm does not resolve them, so publishing to npm needs absolute image URLs here. -->
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../docs/assets/logo_full_white.svg">
    <img alt="Appflare" src="../../docs/assets/logo_full.svg" width="160">
  </picture>
</p>

# create-appflare / @appflare/cli

Installs [Appflare](https://github.com/appflare/appflare), a self-hosted app manager
for Cloudflare, into your own Cloudflare account. Once it runs, you manage it from its
own settings pages.

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
| `--no-telemetry` | Send no anonymous usage data, and install the manager with its usage data turned off (`APPFLARE_TELEMETRY=off`). |
| `-v`, `--version` | Print the installer's version. `--version` followed by a value picks the release instead. |
| `-h`, `--help` | Print the options. |

`GITHUB_TOKEN`, if set, is sent to `api.github.com` when fetching releases and
downloading their files. Set it while the repository is private (for example
`GITHUB_TOKEN=$(gh auth token) npx create-appflare`), or to get around GitHub's rate
limits. Without access, GitHub answers 404, and the installer says the repository
may be private.

A release that was just published can take a few minutes to list all its files.
If the newest release is still incomplete, the installer installs the previous
complete release and prints a warning; run it again later for the newest one.

## Managing the manager

Everything after the install happens in the manager itself. The installer prints
these addresses with your manager's own address in front when it finishes:

| To | Open | Address in the manager |
|---|---|---|
| See the running version and update Appflare | **Settings > Updates** | `/settings/updates#appflare` |
| Enable, update, or disable sandbox builds (Workers Paid) | **Settings > Building apps** | `/settings/building#sandbox` |
| Remove Appflare, its database and its KV namespace | **Settings > Your account > Danger zone**, **Remove Appflare** (owner only) | `/settings/account#danger-zone` |
| Return to an earlier manager version | **Settings > Updates > Recent versions** (admins); if the manager does not load, the Worker's **Deployments** page in the Cloudflare dashboard | `/settings/updates#versions` |

## Forgot your password

If the owner or an admin can no longer sign in, whoever manages the Cloudflare
account can get them back in:

```sh
npx create-appflare recover [--name appflare] [--email admin@example.com] [--yes]
```

It uses the same Cloudflare login as the install, saves a fingerprint of a new random
code on the manager Worker (the secret `RECOVERY_CODE_HASH`), and prints the code. On
the manager's sign-in page, choose **Forgot your password?**, then **I have a recovery
code**, and enter an admin's email, the code, and a new password. The code works once,
for 30 minutes; the manager deletes the secret when it is used. With `--email`, the
code works only with that admin's email. `recover` sends no usage data.

This is by design: anyone who can set secrets on the manager Worker, which means
anyone who controls the Cloudflare account, can reset any admin's password, the
owner's included.

Earlier versions of this package had `status`, `rollback`, `uninstall`, and
`sandbox` commands. Running one of them now prints where its job is done instead.

## Privacy

Appflare collects anonymous usage data to decide what to build and fix. It is on by
default, and the installer says so before it does anything else.

The installer sends one event when it ends: whether it
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
says so; turn them off in **Settings > Usage data**
(`/settings/usage-data#usage-data`). That switch covers the manager's reports only,
not the installer's.

Turn the installer's off with any one of:

- `--no-telemetry`;
- `APPFLARE_TELEMETRY=off` (or `0`, `false`) or `DO_NOT_TRACK=1` in the environment.

With it off, the installer sends nothing and deploys the manager with
`APPFLARE_TELEMETRY=off`, which keeps the manager's usage data off for good (remove
the variable from the Worker to decide in **Settings > Usage data** instead).

The installer also turns off wrangler's own usage metrics and error reports (which
would go to Cloudflare) for the commands it runs, unless you set
`WRANGLER_SEND_METRICS` or `WRANGLER_SEND_ERROR_REPORTS` yourself.
