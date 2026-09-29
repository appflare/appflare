---
title: How the catalog works
description: Pinned commits, signed artifacts, versioned releases, and the nightly install check.
---

The catalog is a public GitHub repository,
[appflare/catalog](https://github.com/appflare/catalog). Each app is one folder,
`apps/<slug>/`, holding a hand-written manifest, `appflare.jsonc`, and an optional
`README.md`. Everything else is produced by the catalog's CI.

Appflare does not use an app's Deploy to Cloudflare button: it installs a signed
build of the pinned commit and keeps it updated.

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

An [app of several Workers](/catalog/submit/#apps-of-several-workers) is built and
bundled one Worker at a time, in the order its entry lists them, and packed into one
artifact. In its `manifest.json` the primary Worker is `worker`, exactly as the
only Worker of a one-Worker app is, and every other Worker is listed in `workers`
with its own modules and static assets. Where a wrangler config names another Worker
of the entry, the artifact records that Worker's name in the entry instead, and the
manager fills in the name it installed that Worker under.

The artifact records each D1 binding's SQL once, under `d1`, keyed by the binding,
since Workers that share a binding share the database: its `migrations`, the
`schema` files and post-deploy migrations (`postDeploy`) that `resources.d1`
declares, and its `baseline`, when it has one.

`manifest.json` says which `format` it is written in, and there is one format, 1. A
manager that meets a later format refuses the artifact and asks the admin to update
Appflare, rather than install the app without something it cannot read. The packer
and the catalog checks refuse a manifest field the schema does not know, so a
misspelled field fails the build instead of being left out.

Releases are immutable. A change to `appflare.jsonc` alone, without a new pin, cannot
be published as a new release; re-pin `source` to ship it. Two exceptions need no
release:

- `authors`, `tagline` and `licenseNote`, which `index.json` reads from the current
  manifest.
- A change to the app's form or copy (its `secrets`, `vars`, `postInstall`, name,
  summary, and similar) made together with a higher `revision`. CI builds nothing:
  the release stays as it is. The signing job signs the revised `appflare.jsonc`
  with the catalog's release key (the same key and key id as the release's
  `manifest.sig`), and the catalog publishes it next to `index.json`, which lists
  its sha256 and signature. The version stays the same, so managers offer no update
  and start no job; they show the new form on the install page and on the **Settings** tab
  of apps already installed from that release.

A revision may change only form fields and copy, but those still reach the app:
var defaults become the Worker's vars, and generated secrets its secrets. That is
why the revised file is signed. A manager uses it only when its sha256 matches the
index, its signature verifies with the keys built into the manager under the
release's key id, and, compared with the signed `manifest.json`, it is for the same
app and changes only the form and copy. The Worker, the resources an install
creates, and the permissions it asks for always come from the signed
`manifest.json`. While a release lists a revision, installs and updates to it need
that file: if it cannot be downloaded or does not verify, they fail instead of
falling back to the older form.

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
