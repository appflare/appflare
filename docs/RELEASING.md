# Releasing Appflare

Appflare's manager is released as a signed artifact on this repository's GitHub
Releases, tagged `manager@<version>`. Nothing is published to npm yet.

## How a release happens

1. Every change that should ship adds a changeset: `pnpm changeset`, pick
   `@appflare/manager`, describe the change. Commit the file under `.changeset/`.
2. On every push to `main`, the `release` workflow (`.github/workflows/release.yml`)
   runs `changesets/action`. While changesets are pending it opens or updates the
   **chore: version packages** pull request (`pnpm changeset version`: bumps
   `apps/manager/package.json` and writes `apps/manager/CHANGELOG.md`).
   The Changesets action only versions; it never creates tags or releases. The
   workflow's own release job is the only thing that tags and publishes.
3. Merging that pull request releases the new version. With no changesets pending,
   the workflow releases `apps/manager/package.json`'s version, always built from
   the version commit (the commit that set that version), unless the release
   `manager@<version>` is already published with its three assets. A draft or
   partial release is completed, and an existing tag must point at the version
   commit. So a failed release is fixed by re-running the workflow or by the next
   push to `main`; commits that landed in between never enter that version.
4. The release runs in isolated jobs:
   - **build** (no secrets): `APPFLARE_VERSION=<version> pnpm release:pack --out
     dist/release --key-id appflare-2026-09` builds the manager with the version
     baked in, stamps the catalog manifest's `source` with the version and commit,
     packs `apps/manager` into an unsigned intermediate, and checks it.
   - **sign** (holds only `APPFLARE_SIGNING_KEY`, runs only the packer): checks
     that `manifest.json` is `appflare@<version>` from the version commit with key id
     `appflare-2026-09`, signs it, and verifies the signature against the public
     keys embedded in `@appflare/schema`.
   - **release**: verifies again and creates the GitHub Release `manager@<version>`
     with `appflare-<version>.zip`, `manifest.json`, and `manifest.sig` (or uploads
     them to a draft or partial release and publishes it); the notes are the
     version's changelog section. A published release with all three assets is
     never replaced: the run succeeds if its `manifest.json` is identical and fails
     otherwise. GitHub shows a new release's assets on its public views (by tag,
     the release list, `gh release download`) only minutes after the upload, so
     the job then waits, up to 15 minutes, until the release lists all three.

To release one specific version again (for example after deleting a broken
release), run the `release` workflow manually on `main` with the `version` input
set to it (`0.2.0`, no leading `v`). It builds from the commit that set
`apps/manager/package.json` to that version. Only the current version is marked
as the repository's latest release. Versions with a pre-release suffix are
     marked as pre-releases.

To pack locally (unsigned unless you pass `--key-id`):

```sh
APPFLARE_VERSION=0.0.1-test pnpm release:pack --out /tmp/manager-release --key-id appflare-2026-09
node packages/pack/bin/appflare-pack.js verify /tmp/manager-release --hashes-only
```

## Repository settings

- Settings > Actions > General > Workflow permissions: allow GitHub Actions to
  create pull requests (needed for the version pull request).
- Pull requests opened with the workflow token do not trigger other workflows, so
  CI does not run on the version pull request by itself. Close and reopen
  it (or push to its branch) to run CI before merging.
- Settings > General > Social preview: GitHub has no API for it, so upload the
  image by hand. `docs/assets/social-preview.png` is this repository's,
  `social-preview-catalog.png` belongs to `appflare/catalog` and
  `social-preview-deploy.png` to `appflare/deploy`; redraw them with
  `CATALOG_SNAPSHOT=live pnpm --filter @appflare/docs social-previews`.

## Secrets

Organization Actions secrets of `appflare`:

| Secret | Used by | Contents |
|---|---|---|
| `APPFLARE_SIGNING_KEY` | `sign` jobs here and in `appflare/catalog` | Base64 PKCS#8 Ed25519 private key |
| `DOCKERHUB_USERNAME` | `sandbox-image.yml` | A Docker Hub account with push access to the `mendylanda` namespace |
| `DOCKERHUB_TOKEN` | `sandbox-image.yml` | A Docker Hub access token of that account, Read & Write scope |
| `DEPLOY_REPO_PUSH_KEY` | `deploy-repo` job of `release.yml` | Private key of a deploy key with write access to `appflare/deploy` (see below) |
| `CLOUDFLARE_API_TOKEN` | `docs.yml` preview deploy | API token for the development account |
| `CLOUDFLARE_ACCOUNT_ID` | same | The development account's id |

Repository Actions secrets of `appflare/appflare`, for the account that owns the
`appflare.dev` zone (`apps/docs/README.md` lists the token's permissions):

| Secret | Used by | Contents |
|---|---|---|
| `DOCS_CLOUDFLARE_API_TOKEN` | `docs.yml` production deploy | API token for that account |
| `DOCS_CLOUDFLARE_ACCOUNT_ID` | same | That account's id |

The release fails with a clear error if `APPFLARE_SIGNING_KEY` is not set, and the
sandbox image workflow if either Docker Hub secret is not set. Without
`DEPLOY_REPO_PUSH_KEY` the deploy repository is not updated, and without either
`DOCS_CLOUDFLARE_*` secret appflare.dev is not updated; each run shows a notice and
succeeds.

## The deploy repository

The "Deploy to Cloudflare" button deploys from the public repository
[`appflare/deploy`](https://github.com/appflare/deploy). It holds the current manager
release as a prebuilt npm project: the release's Worker modules and static assets,
a `wrangler.jsonc`, a `package.json` whose `deploy` script is `wrangler deploy`, and a
`package-lock.json`. `scripts/deploy-repo.ts` explains every choice (no build step,
no `SELF` binding, no secrets, `APPFLARE_INSTALL_SOURCE=deploy-button`).

After each release of the current version, two jobs of `release.yml` update it:

- **deploy-repo-build** (no secrets) downloads the published release, verifies its
  signature and every file's hash, and writes the repository's contents with
  `node scripts/build-deploy-repo.ts`. Before it keeps the copy, the script searches
  every file for the `account_id` of each wrangler config tracked here and for each
  value of at least 16 characters in a local `.env`; if one turns up, it deletes the
  copy and fails, naming the file and where the value comes from (never the value).
- **deploy-repo** (holds only `DEPLOY_REPO_PUSH_KEY`, runs no code from this
  repository) replaces the files on `main` of `appflare/deploy` and pushes one
  commit, `chore(release): appflare <version>`. A repository that already holds this
  version or a newer one is left alone, so re-runs and older versions never add
  commits. "Newer" follows semantic versioning precedence: major, minor and patch
  compare as numbers, and a pre-release ranks below its release, so `0.1.0` replaces
  `0.1.0-rc.1` and `0.1.0-rc.2` replaces `0.1.0-rc.1`, while `0.1.0-rc.1` never
  replaces `0.1.0`. If the repository's `package.json` holds something that is not a
  semantic version, the job fails until a run with **deploy_repo_reset** replaces it.

After a version reset (every package set back to an earlier version, such as
`0.1.0`), `appflare/deploy` still holds the higher version and would never be
updated again. Once the reset version is released, run the release workflow by hand
with **deploy_repo_reset** ticked:

```sh
gh workflow run release.yml --ref main -f deploy_repo_reset=true
```

That run replaces the deploy repository's contents with the current version
whatever version it holds, logs a warning saying so, and adds "Replaces Appflare
<old version> after a version reset." to the commit. Runs started by a push never
reset.

The README's documentation links start at `SITE_URL` in `@appflare/schema/links`,
the one place the site's address is set.

To set up the key once:

```sh
ssh-keygen -t ed25519 -N "" -C "appflare release: appflare/deploy" -f deploy-repo-key
gh repo deploy-key add deploy-repo-key.pub --repo appflare/deploy --allow-write --title "appflare release"
gh secret set DEPLOY_REPO_PUSH_KEY --org appflare --repos appflare < deploy-repo-key
rm deploy-repo-key deploy-repo-key.pub
```

To generate the repository locally from a release directory (a downloaded
`manager@<version>` release, or `pnpm release:pack` output with `--allow-unsigned`):

```sh
pnpm exec turbo run build --filter=@appflare/cli...
pnpm deploy-repo --artifact-dir /tmp/manager-release --out /tmp/appflare-deploy --allow-unsigned
cd /tmp/appflare-deploy && npm ci && npx wrangler deploy --dry-run
```

## The documentation site and the catalog

The docs site (`apps/docs`, deployed by `.github/workflows/docs.yml`) is built once
per run and deployed twice: first as the preview in the development account
(`https://appflare-docs.appflare-dev.workers.dev`), then, once the preview answers,
to appflare.dev in the account that owns the zone. `gh workflow run docs.yml --ref
main -f target=dev` deploys the preview only. `www.appflare.dev` is a Redirect Rule
on the zone, not part of the deploy; `apps/docs/README.md` has the setup.

The site also lists the whole catalog: `/apps/`, one page per app and one per category. The pages are
built from the published catalog at build time, so the site changes only when it is
rebuilt:

- **On each push** that touches the site or the schema, as before.
- **Daily**, on the workflow's schedule, so star and install counts stay current.
  Stars are shown only when the catalog's `stats.json` was less than 72 hours old
  when the site was built, the same rule the manager uses.
- **When the catalog publishes.** The last job of the catalog's publish workflow,
  after the Pages deploy, starts this repository's docs workflow:

  ```sh
  curl -fsS -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer $DOCS_REBUILD_TOKEN" \
    https://api.github.com/repos/appflare/appflare/actions/workflows/docs.yml/dispatches \
    -d '{"ref":"main"}'
  ```

  `DOCS_REBUILD_TOKEN` is a fine-grained token for `appflare/appflare` only, with
  **Actions: write** and nothing else. The job runs no code from either repository
  and takes no inputs; the docs workflow always builds `main` against whatever the
  catalog has published, and a run without inputs deploys appflare.dev.

Only the deploy build reads the published catalog (`CATALOG_SNAPSHOT=live`). It
fetches `index.json`, the `stats.json` the index names, and each app's catalog
manifest (for its repository and homepage), checks every file against the digest
the index gives and everything against `@appflare/schema`, and fails the build on
any error, which leaves the deployed site as it was. The featured slot comes from
the index's `featured` list, which the catalog builds from its `featured.json`.

Every other build (CI, `pnpm build`, the docs tests) uses the small snapshot checked
in at `apps/docs/src/catalog/fixture.json` and never touches the network. To
refresh it from the published catalog:

```sh
pnpm --filter @appflare/schema build
pnpm --filter @appflare/docs catalog:fixture
```

To build the site locally the way the deploy does:

```sh
CATALOG_SNAPSHOT=live pnpm exec turbo run build --filter=@appflare/docs... --force
```

## The sandbox Worker

The optional sandbox Worker (`apps/sandbox`, enabled from the manager's Settings) is released
separately from the manager, under its own version (`apps/sandbox/package.json`):

- Git tag and GitHub Release `sandbox@<version>`, with the assets
  `appflare-sandbox-<version>.zip`, `manifest.json`, and `manifest.sig`, signed with
  the same key as the manager. The manager's **Enable sandbox builds** job downloads the
  version its own release comes with.
- Container image `docker.io/mendylanda/appflare-sandbox:<version>`, which the released Worker
  names in its `containers` config. Docker Hub, because Cloudflare Containers pull
  from the Cloudflare registry, Docker Hub, Amazon ECR, and Google Artifact Registry
  only (not GitHub's registry).

The `release` workflow releases it like the manager: changesets for
`@appflare/sandbox-worker` bump `apps/sandbox/package.json` in the version pull
request (while it is `0.0.0`, nothing is released), and once no changesets are
pending, the `sandbox-*` jobs release that version from its version commit unless
`sandbox@<version>` is already published with its three assets:

- **sandbox-build** (no secrets): `APPFLARE_VERSION=<version> pnpm release:pack
  --app sandbox --out dist/sandbox-release --key-id appflare-2026-09` stamps the
  version into the Worker's config and image tag, packs `apps/sandbox`, and checks it.
- **sandbox-sign**: checks `manifest.json` against the plan and signs it, as for the
  manager.
- **sandbox-image**: calls `.github/workflows/sandbox-image.yml` with the version
  and the version commit. It builds `apps/sandbox/Dockerfile` for `linux/amd64` from
  the repository root (the image carries `@appflare/pack` built from the same
  commit) and pushes `docker.io/mendylanda/appflare-sandbox:<version>`. Image tags are
  immutable: the workflow never pushes a tag twice, and a re-run for a tag that
  already holds an image from the same commit only reports it. Its job summary
  carries the digest.
- **sandbox-release**: creates or completes the GitHub Release `sandbox@<version>`
  with the three assets, never as the repository's latest release. Its notes carry
  the image reference with its digest (`docker.io/mendylanda/appflare-sandbox:<version>@sha256:…`).

The image comes before the release, so a published sandbox Worker release always
has its image. To release one version again, run the `release` workflow by hand
with `sandbox_version` set. `sandbox-image.yml` also runs on a pushed tag
`sandbox@<version>` and by hand with a version whose tag exists.

To pack the sandbox Worker locally (unsigned unless you pass `--key-id`):

```sh
APPFLARE_VERSION=0.1.0 pnpm release:pack --app sandbox --out /tmp/sandbox-release
```

## Hardening when the repository is public

Move the `sign` job behind a GitHub Environment (for example `release`) whose
deployment branches are restricted to `main`, and store `APPFLARE_SIGNING_KEY` as
that environment's secret instead of an org secret, so no other workflow or branch
can read it. Environment secrets are not available to private repositories on the
free plan, which is why the key is an org secret today.

## Signing keys

Artifacts are Ed25519-signed; verifiers pick the public key by the manifest's
`keyId` and reject unknown ids and `unsigned` artifacts. The public keys live in
`packages/schema/src/keys.ts`:

| Key id | Signs |
|---|---|
| `appflare-2026-09` | Manager releases (`manager@<version>`, this repository) |
| `catalog-2026-09` | Catalog app releases (`<slug>@<version>`, `appflare/catalog`) |

Both ids currently share one keypair, so the single org secret signs both
repositories; the separate ids let either repository move to its own key later
without touching the other's artifacts. To generate a new keypair:

```sh
pnpm --filter @appflare/schema keygen --out <file outside any repository> --key-id <id>
```

It writes the private key to the file (mode 0600, never overwriting) and prints
only the path, the key id, and the public key. Add the public key to `keys.ts`,
upload the file's contents as the secret, then delete the file or keep it offline.
