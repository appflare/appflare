---
title: Security model
description: Signed artifacts, pinned builds, what the manager does with your API token, sessions, and roles.
---

The manager holds an API token that can change Workers and data across your
Cloudflare account. Everything below exists to keep that token safe and to make sure
the code it deploys is the code the catalog reviewed.

## The API token

The token you paste in the setup wizard is stored as an encrypted secret,
`CF_API_TOKEN`, on the manager's own Worker. The manager:

- sends it only to `api.cloudflare.com`,
- never writes it to its database or KV,
- never shows it again in the UI, and never sends it back to the browser,
- never includes it in logs, job logs, or error messages. Job logs record each API
  call as `METHOD path -> status` only, without query strings or bodies,
- never gives it to an installed app. Apps receive only the secrets and settings you
  enter for them. An app that needs Cloudflare API access gets its own token, which
  you create with only the permissions it lists.

To replace the token, use **Rotate token** in Settings, then revoke the old one in
the Cloudflare dashboard.

## Signed artifacts

Every app version and every manager release is an artifact with a `manifest.json`
that lists each file with its size and sha256. The manifest is signed with Ed25519.

- The manager and the installer have the public keys built in, each with a key id so
  keys can be rotated. They reject unknown key ids and unsigned artifacts.
- The manager checks that the manifest's sha256 matches the digest in the catalog
  index, then verifies the signature.
- It reads each file from the release with a range request and checks its sha256
  before uploading it. Nothing is uploaded to your account unless the signature and
  every hash match.
- A self-update only accepts a manifest signed with a manager release key.

The private key exists only as a secret in the `appflare` GitHub organization's
Actions. The job that signs holds the key and never runs app code; the jobs that
build apps never see the key.

## Pinned, credential-free builds

The catalog is the trust root for what gets installed. Each app is built from one
exact upstream commit, recorded in its manifest. A change of commit is a pull
request that the app's maintainers review.

Builds install dependencies with `--ignore-scripts`, so no package install script
runs. The build itself is `wrangler deploy --dry-run`, with every `CLOUDFLARE_*` and
`WRANGLER_*` variable, GitHub tokens, and the signing key removed from its
environment. The only thing a build produces is the artifact.

The manager never builds or runs app code. It uploads the files the catalog signed.

## Sign-in and sessions

- **Setup token.** Until the first admin exists, the manager serves only the setup
  wizard, guarded by a one-time token that the installer generated. The manager
  deletes the token from itself once the Cloudflare token is saved.
- **Better Auth.** Users sign in with email and password, or with a passkey they
  added in Settings. Passkeys are bound to the manager's own hostname. There is no
  public sign-up; admins create users. Session cookies are `HttpOnly`, `Secure`, and
  `SameSite=Lax`, and only the manager's own URL is a trusted origin. Sign-in
  attempts are rate limited, with the counters in the manager's D1 database.
- **Roles.** Admins change things; members read everything and change nothing but
  their own passkeys. The
  server checks the role on every action, not just the UI. See
  [Users and roles](/guides/users/).

Apart from the sign-in and setup pages, the only endpoint that answers without a
session is `/api/health`. It reports the manager's version, whether its database
responds, and whether a newer release exists.

## No telemetry

The manager's outbound requests go to the Cloudflare API, the catalog index and
releases on GitHub, and your own apps for health checks. The installer turns off
wrangler's usage metrics and error reports for the commands it runs.
