---
title: Install from a repository
description: Build any GitHub repository with a wrangler config in your own account, public or private with a read-only token, review what it declares, and install it. Also, build a catalog app from source at another commit. Needs Workers Paid and sandbox builds.
---

The catalog lists apps that someone packaged and checked. You can also install a
Workers project that is not in the catalog, straight from its GitHub repository
(public, or private with a [GitHub access token](#private-repositories)), the way the
"Deploy to Cloudflare" button would: your
[sandbox Worker](/guides/builds/) builds it in a container in your own account, you
review what the build declares, and then Appflare installs it like any other app, with
resources it creates and records, updates with a snapshot and a rollback, and an
uninstall that cleans up.

Such an install is marked **Not from the catalog, not checked** wherever it appears, and
is named `owner/repo` so two repositories of the same name stay apart.
Nobody reviewed its code for you, and Appflare never updates it on its own.

## What you need

- **Sandbox builds** turned on in **Settings > Account and capabilities**, which also
  means **Workers Paid** and R2 on the account. See [Sandbox builds](/guides/builds/).
  If the card offers **Update sandbox**, update first: older sandbox Workers cannot
  build from a repository.
- A repository on github.com with a `wrangler.json`, `wrangler.jsonc` or
  `wrangler.toml` at its root (or only a template of one, such as
  `wrangler.toml.example`, which the build copies to its real name), and a lockfile (`pnpm-lock.yaml`,
  `package-lock.json`, `yarn.lock` or `bun.lock`) when it has a `package.json`. A
  private one also needs a [GitHub access token](#private-repositories) that can read it.

## Start a build

On the **Catalog** page, admins see **From a repository**. Enter:

- **Repository**: a GitHub URL such as `https://github.com/owner/repo` or just
  `owner/repo`. A URL that points at a branch or commit (`.../tree/<branch>`,
  `.../commit/<sha>`) fills in the next field.
- **Branch, tag or commit** (optional): the repository's default branch when empty. A
  branch or tag can be checked for changes later; a commit never moves. A commit is
  accepted whenever GitHub serves it for that repository, which includes commits that
  exist only in its forks, so pin commits from a branch you trust.
- **Build command**: **Work it out** runs the project's `package.json` `build` script
  with the package manager its lockfile names, if it has one. **Run this command**
  takes one plain command (no pipes, quotes or variables), and **None** runs nothing
  besides the wrangler config's own `build.command`, as `wrangler deploy` would.

Confirm the cost and choose **Build for review**. Before a container starts, Appflare
reads the repository's branches and tags from GitHub, so a misspelled branch, or a
private repository none of your GitHub access tokens can read, is refused at once, and
the build is pinned to the commit the branch points at right then.

The build runs as a job, and its log opens. In the container, the sandbox Worker:

1. Clones the repository at that commit.
2. Reads the root of the checkout: the lockfile for the package manager, the wrangler
   config, the build command, and the secrets `.dev.vars.example` (or `.env.example`)
   lists, one per `NAME=` line, with the comment above each as its help. A secret whose
   comment says it is optional is optional in the install form. The wrangler config is
   read with wrangler's own reader, whatever its format: each of its plain vars becomes
   a setting you can change, and the sections Appflare cannot deploy are noted.
3. Installs the dependencies with install scripts disabled, then runs the build command
   and `wrangler deploy --dry-run` through the same packer the catalog uses, in an
   environment that holds no credentials.
4. Stores the result, an unsigned artifact, in the sandbox Worker's bucket, and checks
   every file of it.

Nothing is deployed yet. A build of a small project takes a minute or two; the cost is
the container time, as for any [sandbox build](/guides/builds/#what-it-costs).

## Review the build

When the build finishes, its log offers **Review**. The review page shows:

- **Source**: the repository, the branch or tag, the commit, the version Appflare gave
  it (the tag without its `v`, or `0.0.0-<date>.<commit>`), the build command and where
  it came from, and the container image that built it.
- **What it declares**: the resources the install would create (KV namespaces, D1
  databases, R2 buckets, queues, Vectorize indexes, Durable Object classes, Workflows),
  every binding of the Worker, its cron triggers, and the secrets and settings the
  install form will ask for.
- **Runs on**: the Cloudflare services it uses, and whether this account offers each,
  as on a catalog app's page.
- **Why it cannot be installed**, when that is the case, in the words the install would
  use. Appflare installs self-contained Workers only, so it refuses a build with a
  Hyperdrive binding (a repository has no catalog manifest to declare its database),
  an mTLS certificate binding, a service binding or Durable Object binding
  to another Worker, or a wrangler config that uses Containers, dispatch namespaces,
  Tail Workers, Pipelines or Secrets Store secrets.

Below the review is the usual install form. Installing starts the ordinary install job
with this build as its artifact: it is read back from the bucket and checked against
what the review showed before anything is created. A build installs once. **Throw
away** deletes a build you do not want, and its files.

## Build a catalog app from source

A catalog app's page has **Advanced: build from source at a commit** below its
install form, for admins with sandbox builds on. It builds the app's own repository at
the branch, tag or commit you choose, with the catalog's secrets, settings and build
command. The review also says which bindings differ from the catalog's release.

The install is marked **Built from source, not checked**: the catalog checked its own
release, not your commit. It is not updated automatically. When the catalog has a
newer version, updating from the catalog puts its checked release back; you can also
rebuild from source as below.

## Check for changes

The **Overview** tab of an app installed from a repository (or built from source) has a
**Source** card. **Check for changes** reads the newest commit of the branch or tag it
was built from and says whether it moved. **Rebuild and update** builds that commit for
review, with the same build command as before. The review lists any secrets the new
build introduces and asks for them, and says when the new version cannot be checked on
a preview first. **Update** then runs the ordinary update: a snapshot of the Worker and
of each D1 database, the preview check, promotion, and a rollback to the previous build
if you need it.

Appflare never checks for changes or rebuilds on its own, and automatic updates do not
apply to these installs.

## Private repositories

A private repository needs a GitHub access token that can read it. Tokens are listed and
managed in **Settings > Account and capabilities > GitHub access**, which only admins
see; members get nothing about them. With sandbox builds on, an admin adds one:

1. Choose **Add token**, then **Create it on GitHub**. It opens GitHub's page for a new
   fine-grained personal access token with the permissions filled in: **Contents:
   Read-only**, plus **Metadata: Read-only**, which GitHub adds to every token. Pick
   the owner and **Only select repositories**, choose the repositories to install, and
   an expiry. Give it no other permission.
2. Back in Appflare, enter a **Label**, the **Repositories** it covers as you chose them
   (`owner/repo`, or `owner/*` for all of an owner's), and paste the token.

You can add several tokens, for example one per organisation. When a repository is not
public, Appflare tries the tokens in order: the ones whose repositories name it first,
then those naming its owner, then the others. The token that reads it is the one the
build clones with, and **Check for changes** and **Rebuild and update** find it the same
way. The list shows when each token was last used.

Appflare stores each token as a secret on the sandbox Worker, the same way it keeps a
self-deploying app's token, and records only its label, repositories and last use. It
never shows a token again. In a build, only the commands that fetch the repository get
the token, as the password of the https clone; the dependency install and the build
command, which run the repository's own code, never see it, and the job log never shows
it. The token is sent to github.com and api.github.com only.

**Delete** removes the token from the sandbox Worker. Apps already installed keep
running, but a private repository no remaining token covers cannot be rebuilt. Revoke
the token on GitHub as well. Disabling sandbox builds deletes the sandbox Worker, and
every token with it.

While Appflare's own repository is private, one token may be marked **Use for Appflare
release downloads**. Appflare then reads its own releases, and nothing else, with that token (for update
checks, self-updates and updating the sandbox Worker) instead of the `GITHUB_TOKEN`
secret, which stays the fallback. Turning sandbox builds on for the first time cannot
use it, since the token is kept on the sandbox Worker being created.

## If the build fails

The job log and the review page name the step that failed and quote the end of its
output:

- **checkout**: the repository, branch or commit does not exist, or the repository is
  private and the GitHub access token cannot read it (it expired, was revoked, or does
  not cover the repository).
- **detect**: there is no wrangler config at the root, or no lockfile next to
  `package.json`. A monorepo whose Worker sits in a subdirectory cannot be built this
  way yet.
- **install**: the locked dependencies did not install. The lockfile may be out of date
  with `package.json`.
- **build**: the build command failed. Choose another one, or **None**.
- **pack**: wrangler could not bundle the Worker, or the project binds a Vectorize
  index, whose size wrangler's config does not say. Such a project needs a catalog entry.

A build whose container could not start or went away runs once more by itself. Nothing
is deployed by a build, so a failed one leaves nothing to clean up but its log;
**Throw away** deletes that too.

## What is sent

Usage data records that a build, install or update of this kind ran and how it ended,
never the repository, its name, or its version. See [Telemetry](/telemetry/).
