---
title: Security model
description: Signed artifacts, pinned builds, what the manager does with your API token, sessions, roles, notification credentials, and the optional Cloudflare Access protection.
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

To replace the token, use **Rotate token** in **Settings > Your account > Cloudflare connection**, then revoke the old one in
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

The manager never builds or runs app code. For prebuilt apps it uploads the files the
catalog signed.

## Sandbox builds

Some apps have no prebuilt release. If you enable the optional sandbox Worker
(Workers Paid), it builds them in a container in your own account; see
[Sandbox builds](/guides/builds/). What changes:

- **The catalog still decides what is built.** The index pins the exact commit and
  the sha256 of the entry's catalog manifest. The manager checks both before it asks
  for a build, and the build checks out only that commit. This also means that
  whoever controls the catalog index chooses the repository and commit your sandbox
  Worker builds, without a signature in between: the index and the catalog manifest
  are trusted the way the catalog's HTTPS site is. What limits this is the catalog's
  review of every entry and every change of its pinned commit, and that a build runs
  with no credentials.
- **The build has no credentials.** The container holds no Cloudflare token, no API
  key and no R2 keys. Dependency install scripts do not run. The manager's API token
  never leaves the manager; it talks to the sandbox Worker only over a service
  binding, and the sandbox Worker has no public URL.
- **The output is unsigned, and marked so.** The manager accepts an unsigned
  `manifest.json` only through that binding, only when its sha256 matches what the
  build reported, and only when it names the app, the version and the pinned commit
  and carries the catalog manifest the catalog published. Each file is checked against
  it before upload, as for a signed artifact. The app's page says it was built in your
  account, from which commit, with which container image, and that it is unsigned.
- **Your cost, your confirmation.** Each install and update of such an app asks you to
  confirm what the build costs on Workers Paid before it starts.

The app's build scripts are still third-party code that runs in your account's
container with internet access, which is why sandbox tier entries are reviewed by the
catalog like every other entry.

### App tokens of self-deploying apps

A self-deploying app ships its own installer, which the sandbox Worker runs to deploy,
update and remove the app (see [Self-deploying apps](/guides/builds/#self-deploying-apps)).
The installer needs to call the Cloudflare API, so it uses a token you create for that
app, never the manager's.

- **Where the token lives.** The manager stores it as an encrypted secret on the
  sandbox Worker, `APP_TOKEN_<install>`, through the Cloudflare API, and each of the
  app's secret values as `APP_SECRET_<install>_<name>`. It never stores them in its
  database or its logs. Between the install form and that API call, the values exist
  only in the job's Workflow parameters, which Cloudflare Workflows stores encrypted.
- **How it reaches the installer.** The manager never sends it over the service
  binding: a request names only the install. The sandbox Worker reads the token from
  its own secrets and puts it in the environment of the installer's deploy or destroy
  command, and of no other command: the checkout, the dependency install and the build
  still run without credentials. Values the sandbox Worker knows are replaced with
  `[redacted]` in the output it keeps and returns.
- **What reads the account.** After a run, the sandbox Worker lists the app's Workers
  and their bindings with the same app token. The manager's own token is used only to
  store and delete the secrets on the sandbox Worker.
- **What the installer can do** is whatever the token allows, for as long as it runs.
  Create the token with only the permissions the catalog entry lists, and scope it to
  this account. Like build scripts, the installer is third-party code at a reviewed,
  pinned commit.
- **When it goes away.** Uninstalling deletes the token and the secrets from the
  sandbox Worker once the installer's destroy command has run. Revoke the token in the
  dashboard afterwards. Deleting the sandbox Worker also deletes every token it held.
- **Changing them does not cut a run short.** Each secret change deploys a new version
  of the sandbox Worker, which restarts its containers. The manager refuses to change
  them while another job that runs in the sandbox Worker is queued or running, and a
  run that was stopped anyway is retried in a fresh container rather than in the one
  that may still be working.
- **No `.env` overrides.** The sandbox Worker deletes any `.env` in the app's checkout
  before the installer runs, so a file in the repository cannot replace the settings,
  secrets or credentials Appflare hands it. An app's own settings and secrets may not
  use names reserved for the installer's credentials (`CLOUDFLARE_*`, `ALCHEMY_*`) or
  the shell and tools (`PATH`, `NODE_OPTIONS`, `BASH_ENV`, and so on).

## Sign-in and sessions

- **Setup.** Until the owner exists, the manager serves only the setup wizard, and
  its first step asks for a Cloudflare API token. The token is accepted only when
  it belongs to the account the manager runs in: the manager looks up the version
  of itself that is serving the request in the token's account. Anyone who can
  create such a token already controls the account. Saving it gives that browser
  a short-lived setup claim (an `HttpOnly` cookie, 30 minutes); only that browser
  can create the owner, and every other visitor keeps seeing the token step, or
  the sign-in page once the owner exists. Token checks, each one call that
  verifies and saves, are limited to 20 per client address in 10 minutes, and refusals
  carry fixed messages. A manager that cannot identify its own version refuses
  every token unless it is opened at its `workers.dev` address.
- **Better Auth.** Users sign in with email and password, or with a passkey they
  added in **Settings > Users and sign-in > Your passkeys**. Passkeys are bound to the manager's own hostname. There is no
  public sign-up; admins create users. Session cookies are `HttpOnly`, `Secure`, and
  `SameSite=Lax`, and only the manager's own URL is a trusted origin. Sign-in
  attempts are rate limited, with the counters in the manager's D1 database.
- **Roles.** Admins change things; members read everything and change nothing but
  their own passkeys. One admin, the owner, is the only one who can change roles,
  delete users, or transfer ownership; Better Auth's own admin endpoints give admins
  read access only, so they cannot be used to get around that. The server checks the
  role on every action, not just the UI. See [Users and roles](/guides/users/).
- **Password recovery.** A forgotten password is reset from the sign-in page with an
  emailed link (only when the owner turned reset emails on) or a one-time recovery
  code. A code comes from the owner (for any other user), from an admin (for a
  member), or from the installer's `recover` command, which writes a fingerprint of the
  code as the Worker secret `RECOVERY_CODE_HASH`. By design, anyone who can set
  secrets on the manager's Worker, that is, whoever controls the Cloudflare account,
  can reset any admin's password, the owner's included. Links and codes work once,
  for 30 minutes (an account code at most 35 minutes after the version holding it
  was created, whatever expiry was written). Appflare stores reset link tokens and
  codes only as SHA-256 hashes, compares codes in constant time, limits code tries
  to 5 per client address in 10 minutes, deletes the secret once it is used or
  expired, and signs the user out everywhere. Neither codes nor email addresses are
  logged.
  See [Forgot your password](/guides/forgot-password/).

Apart from the sign-in and setup pages, the only endpoint that answers without a
session is `/api/health`, also when [Cloudflare Access](#protect-with-cloudflare-access)
protection is on. It reports the manager's version, whether its database
responds, and whether a newer release exists.

## Protect with Cloudflare Access

**Settings > Users and sign-in > Cloudflare Access** has an optional extra layer for admins: **Protect with Cloudflare Access**.
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
- Keeps the allow list current: adding an admin in **Settings > Users and sign-in** adds their email, and
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
and the manager's settings are out of reach. Recover in two steps:

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
works, you can turn the protection on again from **Settings > Users and sign-in > Cloudflare Access**.

## Notification credentials

[Notification channels](/guides/notifications/) need credentials of their own: a
Telegram bot token, a Slack or Discord webhook URL, or a generic webhook's URL and
signing secret. The manager encrypts them with AES-GCM before they reach its D1
database, under a key derived from its `BETTER_AUTH_SECRET` Worker secret, so the
database alone does not reveal them. Each ciphertext is bound to its channel, so it
cannot be moved to another one. Once saved, a credential is never shown again, not
even to admins: the channel list shows only a chat id, a webhook id or a host name, and a webhook's
signing secret is shown once, when it is made. Credentials never appear in messages,
logs, or error text; an error a service returns is stored with every credential of
the channel removed. Messages are sent only to the address the admin entered, with
no redirects followed, so a signed body never reaches a host nobody named. If
`BETTER_AUTH_SECRET` is ever replaced, the stored credentials can no longer be
decrypted: the channels show **Credentials unreadable** and send nothing until an
admin enters the credentials again.

## Usage data

Besides the Cloudflare API, the catalog site and releases on GitHub, your own apps
for health checks, and the notification channels you add, the manager sends anonymous usage data (a daily report and
the outcome of each job) to PostHog's EU region, from its Worker and never from your
browser. It holds counts, versions and error categories, never your account, emails,
domains, secrets or tokens. It is on by
default and starts with the first scheduled run after setup. No banner in the app
announces it: **Settings > Usage data** and these docs disclose it, and nothing waits for
an answer. One switch there turns it off; see [Usage data](/telemetry/) for
exactly what is sent and every way to turn it off. The installer keeps wrangler's
own usage metrics and error reports off for the commands it runs.
