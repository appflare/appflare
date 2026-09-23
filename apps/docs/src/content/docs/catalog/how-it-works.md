---
title: How the catalog works
description: Pinned commits, signed artifacts, versioned releases, and the nightly install check.
---

The catalog is a public GitHub repository,
[appflare/catalog](https://github.com/appflare/catalog). Each app is one folder,
`apps/<slug>/`, holding a hand-written manifest, `appflare.jsonc`, and an optional
`README.md`. Everything else is produced by the catalog's CI.

## An entry pins one commit

The manifest names the upstream repository and one exact commit:

```jsonc
"source": { "ref": "v3.3.1", "sha": "<40-character commit SHA>" }
```

Builds always use `sha`. `ref` says which tag or branch the commit belongs to, and a
semver tag becomes the app's version (`v3.3.1` gives `3.3.1`). An untagged commit
gets a version from its date and SHA, such as `0.0.0-20251222.61a83bd`.

Moving an app to a newer upstream version means changing the pin in a pull request.
The [bump bot](/catalog/bumps/) opens those pull requests.

## CI packs and signs each version

When a change to an app reaches the `main` branch, CI:

1. Checks out the upstream repository at the pinned commit.
2. Installs its dependencies with install scripts disabled (`--ignore-scripts`), and
   builds it with `wrangler deploy --dry-run`, which bundles the Worker without
   deploying it. The build runs with no Cloudflare credentials, no GitHub token, and
   no signing key in its environment.
3. Packs the result into an **artifact**: an uncompressed zip of the Worker modules,
   static assets, and D1 migrations, plus `manifest.json`, which lists every file
   with its size, offset, and sha256, and embeds the app's `appflare.jsonc`.
4. Signs `manifest.json` with the catalog's Ed25519 key, in a separate job that
   never runs app code.
5. Publishes a GitHub Release tagged `<slug>@<version>` with three files:
   `<slug>-<version>.zip`, `manifest.json`, and `manifest.sig`.
6. Regenerates `index.json`, the list of apps with their latest version, artifact
   URLs, and manifest digest, and publishes it to
   `https://appflare.github.io/catalog/index.json`.

Releases are immutable. A change to `appflare.jsonc` alone, without a new pin, cannot
be published; re-pin `source` to ship it.

## The manager installs from the artifact

The manager reads `index.json`, downloads `manifest.json` and `manifest.sig`, and
checks the signature against the public keys built into it. It then reads each file
straight out of the release zip with HTTP range requests and checks its sha256
before uploading it to your account. Nothing from the app's repository runs anywhere
except in the catalog's build. See [Security model](/security/).

## The nightly install check

Every night, CI takes the current release of every app, installs it into a dedicated
Cloudflare test account, requests its health path, and deletes it again. Each app
that passes gets a new check date in `index.json`. The manager shows it as **Install
checked** on the catalog.

An app that fails stays in the catalog and keeps its previous date, so a date that
stops moving means recent checks failed.

The install check uses random secrets and default settings. It proves the Worker
deploys and starts, not that the app is fully configured.
