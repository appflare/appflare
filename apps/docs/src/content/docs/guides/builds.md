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
from the command line, connect your manager to it in **Settings**, and remove it the
same way.

:::note[No sandbox tier apps in the catalog yet]
The manager and the sandbox Worker support sandbox builds, but the catalog does not
publish sandbox tier entries yet. Until it does, the catalog shows no app that is
built this way.
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

## Connect the manager

The manager reaches the sandbox Worker through a service binding named `SANDBOX`. A
manager that was installed before the sandbox Worker existed does not have it yet.

Open **Settings > Sandbox builds**. It shows one of three states:

- **Off**, with the `sandbox enable` command, when the account has no sandbox Worker.
- **Connect sandbox builds**, when the sandbox Worker exists but the manager is not
  bound to it. Only admins see the button.
- **Connected**, with the sandbox Worker's version and container image.

Connecting does not re-upload the manager. It creates a new version of the manager's
Worker from the one that is running, with only the `SANDBOX` binding added. It checks
that version's preview URL at `/api/health` like a self-update does, and only then
deploys it to all traffic. If the check fails, nothing changes. Connecting refuses
while a self-update runs, and when a newer version of the manager was uploaded but not
deployed.

Every self-update after that keeps the binding while the `appflare-sandbox` Worker
exists, adds it when the Worker appeared since, and drops it with a warning in the job
log once the Worker is gone.

## Install a sandbox tier app

A sandbox tier app shows **Built in your account** in the catalog. Its page shows the
commit it is built from, the container size, and what one build costs. The install
form asks you to confirm that cost, next to the Workers Paid confirmation. Without a
connected sandbox Worker the form stays disabled and says why.

The install job then runs these steps before the usual install:

1. **check sandbox Worker**: the binding exists and the sandbox Worker speaks this
   manager's protocol version.
2. **load catalog manifest**: the entry's catalog manifest, published next to the
   catalog index, must match the digest in the index, name this app, be a sandbox tier
   entry, and pin the same commit.
3. **build in sandbox**: one call to the sandbox Worker that returns when the build is
   done. While it runs, the job page shows the build's latest output, read from the
   sandbox Worker every two seconds. When it ends, the last 40 lines go into the job
   log. A build runs at most twice: once more if its container could not start,
   stopped, or the build took longer than 55 minutes. A failing command is not run
   again. A second run costs as much as the first.
4. **verify built manifest**: see [What you are trusting](#what-you-are-trusting).

After that the job installs the build exactly as it installs a prebuilt artifact,
reading each file with a range request through the sandbox Worker. The app's page
says **Built in your account from `<commit>` with image `<image>`, unsigned**.

Updates of a sandbox tier app build the new version the same way, and ask you to
confirm the cost first. Whether the new version can be checked on a preview URL is
known only after the build. If the installed version already has no preview (it
implements a Durable Object), the update asks you to accept that up front; otherwise
you can tick **update without that check** in advance. If the build turns out to need
a deploy without a preview check and you did not accept it, the update stops before
anything changes and you can start it again. After a
successful update the sandbox Worker keeps the builds of the new version and the one
before it and deletes older ones. Uninstalling deletes all of the install's builds. A
rollback returns to the snapshot's Worker version and its recorded provenance; it does
not rebuild anything.

## What a build does

Installing or updating a sandbox tier app asks the sandbox Worker to build that
version. In a fresh container, the sandbox Worker:

1. Clones the app's repository at the catalog's pinned commit and checks that the
   checkout is exactly that commit. If the tag has moved since the catalog pinned it,
   it fetches the pinned commit itself.
2. Installs the dependencies from the lockfile with install scripts disabled.
3. Packs the Worker with `@appflare/pack`, the same packer catalog CI uses. The packer
   first runs the build command the catalog entry declares, if any, then
   `wrangler deploy --dry-run` to bundle it.
4. Copies the artifact into the `appflare-builds` bucket, checks every file in it
   against the artifact's manifest, and deletes the container.

The manager then installs the artifact exactly as it installs a prebuilt one.

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
  built in your account and is not signed. The manager accepts an unsigned
  `manifest.json` only when it reads it through the `SANDBOX` binding, and only when
  its sha256 is the digest the build reported, it names this app and version, it was
  built from the pinned commit, and it carries exactly the catalog manifest the catalog
  published for the entry. Every file is then checked against that manifest before it
  is uploaded. The app is shown as built in your account from its commit rather than as
  signed.

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
reinstalled. Settings shows the manager as connected but not answering until its next
self-update drops the binding. Without `--purge`, the bucket stays, and enabling the sandbox Worker
again uses it.

## Troubleshooting

**Appflare is not connected to a sandbox Worker.** Run `sandbox enable`, then use
**Connect sandbox builds** in Settings.

**The sandbox Worker speaks another protocol.** The manager and the sandbox Worker are
from releases that do not match. Update whichever is older: run `sandbox enable` again,
or update Appflare in Settings.

**Sandbox builds need Workers Paid.** The account is on the free plan. Upgrade it
under **Workers & Pages > Plans** in the dashboard and run `sandbox enable` again.

**R2 is not enabled on this account.** Open **R2** in the dashboard once, then run
`sandbox enable` again.

**A build fails in the install step.** The app's lockfile does not match its
`package.json` at the pinned commit, or a dependency needs its install script. The
job log shows the package manager's output; report it on the catalog entry.

**The first build takes longer.** Cloudflare pulls the sandbox Worker image from Docker Hub
the first time a container starts in a location. Later builds start faster.
