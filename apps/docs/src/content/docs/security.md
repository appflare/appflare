---
title: Security model
description: Signed artifacts, pinned builds, what the manager does with your API token, sessions, roles, and the optional Cloudflare Access protection.
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
session is `/api/health`, also when [Cloudflare Access](#protect-with-cloudflare-access)
protection is on. It reports the manager's version, whether its database
responds, and whether a newer release exists.

## Protect with Cloudflare Access

Settings has an optional extra layer for admins: **Protect with Cloudflare Access**.
When it is on, [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
asks every visitor to prove they own an admin's email before the manager's own
sign-in page loads, and the manager itself checks the Access token on every request
and refuses anything without a valid one.

What turning it on does:

- Creates a self-hosted Access application named "Appflare (<your manager's
  hostname>)" with one allow policy listing every admin's email, and a second
  application that keeps `/api/health` open so health checks keep working.
- Stores the application's audience tag and your team domain. From then on every
  request except `/api/health` must carry a `Cf-Access-Jwt-Assertion` token signed
  by your team's keys and issued for that application; otherwise the manager answers
  with a 403 page that says why. The token is never logged.
- Keeps the allow list current: adding an admin in Settings adds their email, and
  **Re-sync admins** rewrites the list after any other change.

Turning it off deletes both applications and stops the checks. The manager's own
sign-in keeps protecting it either way.

### Before you turn it on

- The account needs a Zero Trust organization. The Free plan covers up to 50 users;
  the manager links to the dashboard to create one if there is none.
- The API token needs **Access: Apps and Policies** (Edit) and **Access:
  Organizations, Identity Providers, and Groups** (Read). The token template
  requests both; an older token needs rotating first. The manager checks both
  before it changes anything.
- You must be able to sign in to Access with your own admin email. A new Zero
  Trust organization often offers only the Cloudflare account login method, which
  admits members of this Cloudflare account with their Cloudflare login email. To
  let other emails in, add One-time PIN as a login method in the Zero Trust
  dashboard first. The confirmation dialog lists the login methods your
  organization has.

### If you are locked out

If Access will not let you in, you see Cloudflare's Access page, not the manager's,
and Settings is out of reach. Recover in two steps:

1. In the Zero Trust dashboard, under Access applications, delete the application
   named "Appflare (<your manager's hostname>)". Access stops asking for a sign-in.
2. The manager still requires Access tokens and now answers with its own 403 page.
   From a terminal where wrangler is signed in to this account, turn the check off
   by deleting its settings, replacing `DATABASE` with the name of the manager's D1
   database (the `DB` binding on the manager's Worker):

   ```sh
   npx wrangler d1 execute DATABASE --remote --command "DELETE FROM settings WHERE key LIKE 'access_%'"
   ```

The manager picks up the change within about 15 seconds. Delete the leftover
application for `/api/health` in the dashboard as well. Once your Access sign-in
works, you can turn the protection on again from Settings.

## No telemetry

The manager's outbound requests go to the Cloudflare API, the catalog index and
releases on GitHub, and your own apps for health checks. The installer turns off
wrangler's usage metrics and error reports for the commands it runs.
