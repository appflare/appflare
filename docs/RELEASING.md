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

## Secrets

Organization Actions secrets of `appflare`:

| Secret | Used by | Contents |
|---|---|---|
| `APPFLARE_SIGNING_KEY` | `sign` jobs here and in `appflare/catalog` | Base64 PKCS#8 Ed25519 private key |
| `CLOUDFLARE_API_TOKEN` | later: CI installs into a test account | API token for that account |
| `CLOUDFLARE_ACCOUNT_ID` | later: same | That account's id |

The release fails with a clear error if `APPFLARE_SIGNING_KEY` is not set.

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
