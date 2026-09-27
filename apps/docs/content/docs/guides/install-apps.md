---
title: Install an app
description: The install form, secrets, what the install job does, and post-install steps.
---

Open the app's page in **Catalog**. Only admins can install apps.

## The install form

**Worker name.** The app is served at
`https://<worker-name>.<your-subdomain>.workers.dev`, and its resources are named
after it. Use 1 to 54 lowercase letters, digits, or dashes, not starting or ending
with a dash. The name must not belong to an existing Worker in the account: Appflare
never takes over a Worker it did not create.

**Name.** How this install is listed in Appflare. It defaults to the Worker name.

**Secrets.** Stored as encrypted secrets on the app's Worker. Appflare keeps only
their names. Some secrets are generated for you: the field is filled with a random
32-character value (or, for an app that sends push notifications, a new VAPID
private key) that you can copy, replace, or regenerate. Copy it before you
install. It is shown only on this form and cannot be read back afterwards. A secret
marked optional is one the app works without: it is left unset unless you turn on
**Set now**, and you can set or remove it later in the app's
[settings](/guides/settings/#remove-a-secret).

**Settings.** Variables on the app's Worker, for example a home page URL. A setting
starts with the app's default. When the default names the app's own address, the
form shows it filled in for the Worker name you typed, and the install fills in the
real workers.dev address (also when you attach a custom domain later). Only settings
you change are stored; the others follow the app's default on each update. Settings marked JSON take a JSON value, such as `["inbox@example.com"]`,
and the form checks it before you can install. A setting with a fixed set of values
shows them as choices: cards for up to four, a dropdown for more. A setting derived
from a secret, such as the public key of a VAPID private key, is read-only: Appflare
computes it at install, and again whenever that secret gets a new value.

**Address.** Where the app answers besides its `workers.dev` URL: **workers.dev
only** (the default), a [custom domain](/guides/custom-domains/) in one of this
account's domains, or an [external domain](/guides/external-domains/) whose DNS is
managed elsewhere. The install adds the domain once the app runs. A domain that
cannot be added then does not fail the install; the log says why, and you can add it
later on the app's **Domains and email** tab. A
[self-deploying app](/guides/builds/#self-deploying-apps) has no **Address**: its
own installer decides where its Workers answer.

Select **Install**. The manager starts an install job and opens its live log.

## Apps with a database elsewhere

Some apps keep their data in a PostgreSQL or MySQL database that runs outside
Cloudflare, such as one at Neon, Supabase, PlanetScale, or on your own server. The
catalog marks them **Database elsewhere**, provided by you. Their install form has a
**Databases** group with one connection string field per database, such as
`postgres://user:password@db.example.com:5432/app`. The database must accept
connections from the internet with that user and password.

The install job gives the string to Cloudflare Hyperdrive, which connects to the
database before it answers, and binds the resulting Hyperdrive configuration
(`<worker name>-<binding>`) to the app's Worker. A database Cloudflare cannot reach
ends the install before the Worker is uploaded, with Cloudflare's reason. Appflare
never stores the connection string: it is not shown again, and it is not in the job's
record or log. The API token needs the optional **Hyperdrive: Edit** permission.

To point the app at another database, or to change its password, open the app's
**Settings**, choose **Replace connection string**, and save. Appflare creates a new
Hyperdrive configuration, uploads the app with it, checks the new version on a preview
where Cloudflare allows it, and switches traffic to it. The old configuration is kept,
listed as a replaced Hyperdrive configuration, so undoing the change from **Versions**
still reaches the old database; a rollback makes it the app's configuration again. The
next successful update or settings change deletes it; from then on, **Versions** shows
older snapshots that bound it as not available for rollback, since their version would
have no database. Uninstalling deletes all of the
app's Hyperdrive configurations; the databases themselves are yours and stay as they
are.

## Several installs of one app

You can install an app more than once, each under its own Worker name. The form
suggests a free name: `cut`, then `cut-2`, `cut-3`, and so on. Each install has its
own resources, secrets, and updates.

A few apps only work under one Worker name, for example because they hard-code their
own hostname. For those the Worker name field is read-only and the app installs once
per account.

## Workers Free or Workers Paid

Appflare reads your account's Workers plan from its subscriptions when the Cloudflare
token has the optional **Billing: Read** permission, and shows it in **Settings**, under
**Account and capabilities**, marked **Detected**. It checks when the token is saved, once a
day, and when you select **Re-check**. Without that permission, you state the plan
there yourself (marked **Set by you**); until you do, Appflare treats the account as on
Workers Free. A detected plan always comes first.

- On **Workers Paid**, the install form does not ask you to confirm Workers Paid for
  apps that need it, and installs and updates skip the count of the account's cron
  triggers.
- On **Workers Free**, the install form asks **This account is on Workers Paid** for
  each app that needs Workers Paid, and offers it as an option for an app with cron
  triggers. Ticking it also offers **Remember this for the account**, which records
  Workers Paid in Settings, unless the plan was detected.

The catalog page and the install form show how many cron triggers an app uses. The
update dialog shows it too when a new version adds cron triggers.

## What the install job does

Each step is a durable Workflow step, retried on its own if a Cloudflare API call
fails for a moment. The log shows every API call as `METHOD path -> status`.

1. Fetches the app's signed manifest from the catalog release and verifies its
   signature.
2. Checks the plan, the requirements, and the Worker name. For apps that bind R2, it
   checks that R2 is enabled. For apps with cron triggers, it counts the cron
   triggers your other Workers use and stops if the app's own would take the account
   past the 5 Workers Free allows. The count is skipped when the account is on
   Workers Paid (see below).
3. Creates each KV namespace, D1 database, R2 bucket, queue, and Vectorize index the
   app binds, named `<worker-name>-<binding>` (lower case, `_` becomes `-`). It
   records each one as it goes. If a resource with that name already exists in the
   account, the install stops instead of adopting it.
4. Uploads the app's static assets, then the Worker with every binding filled in.
   Every file is read from the signed release and checked against its sha256 first.
5. Applies the app's D1 migrations, in the same `d1_migrations` table wrangler uses.
6. Sets the secrets and the cron triggers, attaches the Worker to each queue it
   consumes, and enables the `workers.dev` route. A queue that only a consumer names,
   such as a dead-letter queue, is created in step 3 as `<worker-name>-<queue name>`.
7. Runs a [health check](/guides/health/).

For an [app of several Workers](#apps-of-several-workers), step 4 and step 6 run
once per Worker, as described below.

If a step fails, the job stops and names the step. Everything created so far stays
recorded. Nothing is deleted automatically. To try again, [uninstall](/guides/uninstall/)
the failed install, which removes what it created, and install again.

## Apps of several Workers

Some apps install as several Workers, for example a web front end and an API. One of
them is the app: it runs under the Worker name you choose, serves the app's address
and any custom or external domain, and answers the health check. Every other Worker
runs as `<worker-name>-<name>` on its own `workers.dev` address; an app installed as
`notes` with an `api` Worker also gets `notes-api`.

On Workers Free an app may have at most three Workers: each one adds requests
to the install job, which the free plan limits to 50, so the manager refuses a
larger app there before creating anything.

The form asks for each secret and setting once. The manager sets it on the Workers
of the app that use it. Post-install steps and settings can mention any of the
Workers' addresses, filled in for this install.

The install job creates the app's resources first, one for each binding name: two
Workers that bind `DB` share one D1 database. It then deploys the Workers one at a
time, each after the Workers it binds to, with the app's own Worker as late as
possible. Each gets its own static assets, secrets, cron triggers, queue consumers,
and `workers.dev` address. D1 migrations run once all of them are deployed, and the
health check requests the app's own Worker.

The app's page lists each Worker under its resources. [Updates and
rollbacks](/guides/updates/#apps-of-several-workers), [settings
changes](/guides/settings/), and [uninstalling](/guides/uninstall/) always cover
every Worker of the app.

## Post-install steps

When the install finishes, the app's page shows **Next steps** if the app has any:
where to sign in, which URL to point a client at, what to configure first. They can
mention the app's URL and Worker name, filled in for this install.

## The app's page

**Installed apps** lists every install. An app's page shows its status, version,
health, resources, secret names, jobs, and the actions for
[updates and rollbacks](/guides/updates/), [changing settings and
secrets](/guides/settings/), and [uninstalling](/guides/uninstall/).
