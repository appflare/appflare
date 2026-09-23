---
title: Sandbox builds
description: Build apps that have no prebuilt release inside a container in your own account. Needs Workers Paid.
---

Most catalog apps ship a prebuilt artifact: catalog CI builds each version from its
pinned commit, signs it, and your manager installs it. Some apps cannot be prebuilt
that way. Their catalog entries use the **sandbox** tier: Appflare builds them for you,
from the same pinned commit, inside a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/)
container in your own account.

That work is done by an optional second Worker, `appflare-sandbox`. You add it once,
from the command line, and remove it the same way.

:::note[Coming in a following release]
This release ships the sandbox Worker and the `sandbox` commands. The manager's side,
connecting to the sandbox Worker and installing sandbox tier apps through it, comes in
a following Appflare release. Until then, the sections below on installs describe how
it will work.
:::

## What you need

- **Workers Paid** on the account (US$5 a month). The builds run in Cloudflare
  Containers, which the free plan does not include.
- **R2** enabled on the account. The sandbox Worker keeps build outputs and logs in an R2
  bucket. If you have never used R2, open **R2** in the Cloudflare dashboard once to
  enable it.
- Node.js 22 and a wrangler login, as for [installing Appflare](/start/install/).

## Enable it

```sh
npx @appflare/cli sandbox enable
```

The command downloads the newest sandbox Worker release from
`github.com/appflare/appflare/releases` (`sandbox@<version>`), checks its signature
the same way the installer checks the manager's, and deploys it with wrangler from a
temporary directory. Nothing is left on your computer.

It creates:

| Resource | Name |
| --- | --- |
| Worker | `appflare-sandbox`, with no `workers.dev` URL and no routes |
| Container applications | `appflare-sandbox-standard-1` (`standard-1`) and `appflare-sandbox-standard-2` (`standard-2`) |
| R2 bucket | `appflare-builds` |

The containers run the image `docker.io/appflare/sandbox:<version>`, where the
version is the sandbox Worker's own. Each tag is published once and never changed.

The sandbox Worker has no public URL. It is built to be reached only by your manager,
through a service binding.

To update the sandbox Worker, run `sandbox enable` again. Pass `--version <x.y.z>` for a
specific release. `--yes` never asks anything; with several accounts, set
`CLOUDFLARE_ACCOUNT_ID`.

If the account is on the free plan, the command stops with **Sandbox builds need
Workers Paid** and deploys nothing that runs.

## What a build does

Once the manager supports it, installing or updating a sandbox tier app asks the
sandbox Worker to build that version. In a fresh container, the sandbox Worker:

1. Clones the app's repository at the catalog's pinned commit and checks that the
   checkout is exactly that commit. If the tag has moved since the catalog pinned it,
   it fetches the pinned commit itself.
2. Installs the dependencies from the lockfile with install scripts disabled.
3. Packs the Worker with `@appflare/pack`, the same packer catalog CI uses. The packer
   first runs the build command the catalog entry declares, if any, then
   `wrangler deploy --dry-run` to bundle it.
4. Copies the artifact into the `appflare-builds` bucket, checks every file in it
   against the artifact's manifest, and deletes the container.

The manager will then install the artifact exactly as it installs a prebuilt one, and
the job page will show the build's output while it runs.

## What you are trusting

- **The pinned commit.** The catalog reviews each sandbox tier entry and pins an exact
  commit. The sandbox Worker builds only that commit; a moved tag cannot change what is
  built.
- **No install scripts, no credentials.** Dependency install scripts never run. The
  container holds no Cloudflare token or key of any kind, so the code it runs has
  nothing to act on your account with. The build output reaches R2 through the
  sandbox Worker's own binding, not with keys. Outbound traffic from the container is
  not filtered: a build needs the internet to fetch its dependencies, so it can reach
  any host over HTTPS.
- **Unsigned output.** A prebuilt artifact is signed by catalog CI. A sandbox build is
  built in your account and is not signed. The manager will accept it only from your
  sandbox Worker, check it against the digest the sandbox Worker reports, and show the
  app as built in your account from its commit rather than as signed.

The app's own code is still third-party code, as with any app you install.

## What it costs

Workers Paid includes some container usage each month: 25 GiB-hours of memory,
375 vCPU-minutes, and 200 GB-hours of disk. Beyond that, a build costs what its
container uses while it runs:

| Container | Size | A 10-minute build |
| --- | --- | --- |
| `standard-1` (default) | 1/2 vCPU, 4 GiB memory, 8 GB disk | about US$0.012 |
| `standard-2` (entries that ask for it) | 1 vCPU, 6 GiB memory, 12 GB disk | about US$0.022 |

With the included usage, about 35 ten-minute `standard-1` builds a month cost nothing
extra. Most builds take less than ten minutes. The container is deleted when the
build ends, so nothing runs between builds. Build outputs in R2 are small and usually
stay within R2's free storage. See Cloudflare's
[Containers pricing](https://developers.cloudflare.com/containers/pricing/) for the
current rates.

## Disable it

```sh
npx @appflare/cli sandbox disable --yes [--purge]
```

Deletes the `appflare-sandbox` Worker and its container applications. The command
checks first that the Worker really is an Appflare sandbox Worker and refuses otherwise.

| Flag | Meaning |
| --- | --- |
| `--yes` | Required. Confirms deleting the Worker. |
| `--purge` | Also empty and delete the `appflare-builds` bucket, with every build output and log. Asks you to type `appflare-sandbox` first. |
| `--i-understand-data-loss` | With `--yes --purge`, skip typing the name. For scripts. |

Apps that were built by the sandbox Worker keep running. Without the sandbox Worker,
sandbox tier apps cannot be built, so they cannot be installed, updated, or
reinstalled. Without `--purge`, the bucket stays, and enabling the sandbox Worker
again uses it.

## Troubleshooting

**Sandbox builds need Workers Paid.** The account is on the free plan. Upgrade it
under **Workers & Pages > Plans** in the dashboard and run `sandbox enable` again.

**R2 is not enabled on this account.** Open **R2** in the dashboard once, then run
`sandbox enable` again.

**A build fails in the install step.** The app's lockfile does not match its
`package.json` at the pinned commit, or a dependency needs its install script. The
job log shows the package manager's output; report it on the catalog entry.

**The first build takes longer.** Cloudflare pulls the sandbox Worker image from Docker Hub
the first time a container starts in a location. Later builds start faster.
