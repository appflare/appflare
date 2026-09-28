---
title: Install an app
description: The install form, secrets, what the install job does, and post-install steps.
---

Open the app's page in **Catalog**. Only admins can install apps.

![Install form with plain setting names and an App address chip](/screenshots/install-app-settings.png)

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
install. It is shown only on this form and cannot be read back afterwards. A
secret of several lines, such as a PEM private key, gets a text area: paste it with
its line breaks. Its text shows while you enter it and cannot be read back once
the app is installed. A secret
marked optional is one the app works without: it is left unset unless you turn on
**Set it now**, and you can set or remove it later in the app's
[settings](/guides/settings/#remove-a-secret).

Fields show the app's own labels. The name the app reads each value under (its
variable or secret name) shows when you hover over a label, or next to every label
once you turn on **Show technical names** at the top of the form. Long help shows
its first sentence; **More** shows the rest.

**Settings.** Variables on the app's Worker, for example a home page URL. A setting
starts with the app's default. Parts of it that Appflare fills in, such as the app's
address, its Worker name or your account ID, show as chips ("App address",
"Account ID"). Hover over, click or tap a chip's name to see what it becomes. A chip
is removed whole with Backspace or Delete, or with its ×, and **Insert** on the field
adds one back. The setting keeps
the chip, not its current value, so the app's address follows the Worker name you
typed, and follows the app's domain if its
[workers.dev URL is turned off](/guides/custom-domains/#turn-off-the-workersdev-url)
later. Only settings you change are stored; the others follow the app's default on
each update. Settings marked JSON take a JSON value, such as `["inbox@example.com"]`,
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

## Apps that stream events

Some apps, such as analytics, send events through Cloudflare Pipelines into an Apache
Iceberg table in R2, which they then query with R2 SQL. Pipelines is in open beta and
only on Workers Paid, so these apps need Workers Paid, and the catalog lists
**Pipelines** among what they use.

Their install form asks for an API token the app's data lives behind: create an R2 API
token with **Admin Read & Write** (it carries Workers R2 Data Catalog and Workers R2
Storage write access, and R2 SQL read), and paste it into the field the app names. The
app's page lists these permissions with a link to the dashboard's R2 API tokens page.
Cloudflare keeps that token as the sink's credential, and the app receives it as a
secret, usually to query its tables with R2 SQL. By the app's own design this token
reaches every R2 bucket in the account, not only the app's: Cloudflare offers no R2
SQL or Data Catalog token narrower than the account's buckets that a sink accepts.
Appflare's own token never leaves the manager.

Changing that secret later in the app's **Settings** gives the app the new token and
stores it as the catalog's maintenance credential, but the sink keeps writing with the
token it was created with: Cloudflare cannot change a sink, and a new sink cannot write
to a table that already exists. Keep the original token valid while the app is
installed; the job log says so when the secret changes.

For each stream the app binds, the install job:

1. Creates the R2 bucket the events land in, `<worker-name>-<name>`, unless it is a
   bucket the app already binds.
2. Turns on R2 Data Catalog for the bucket with the app's token and, when the app
   asks for them, compaction and snapshot expiration.
3. Creates the stream (`<worker_name>_<binding>_stream`, with the schema the app
   declares and no HTTP endpoint), an R2 Data Catalog sink that writes to the app's
   table, and a pipeline between them, then binds the stream to the Worker.

The stream, sink and pipeline cannot be changed once created, so updates keep them.
An update to a version that changes a stream's schema or the table it writes to is
refused with a message, and so is one that adds a stream (its sink needs the token
entered at install, which the manager cannot read back): such a version needs a fresh
install. Uninstalling deletes the pipeline, the sink and the stream;
the bucket is listed with the app's other data, and keeping it keeps its Data Catalog
and the table. Appflare's token needs the optional **Pipelines: Edit** permission, and
**Workers R2 Data Catalog: Edit** (added by hand) for an uninstall to remove the Data
Catalog of a bucket it deletes.

## Several installs of one app

You can install an app more than once, each under its own Worker name. The form
suggests a free name: `cut`, then `cut-2`, `cut-3`, and so on. Each install has its
own resources, secrets, and updates.

A few apps only work under one Worker name, for example because they hard-code their
own hostname. For those the Worker name field is read-only and the app installs once
per account.

## Workers Free or Workers Paid

Appflare reads your account's Workers plan from its subscriptions when the Cloudflare
token has the optional **Billing: Read** permission (or from Containers, which only
Workers Paid includes), and shows it in **Settings > Your account**, under **What this
account can run**; the row's **Details** say it was detected. It checks when the token is
saved, once a day, and when you select **Check again**. When Appflare cannot tell, the
Workers plan row offers **Choose plan** so you state it yourself (its **Details** then say
"set by you"); until you do, Appflare treats the account as on Workers Free. A detected
plan always comes first.

- On **Workers Paid**, the install form does not ask you to confirm Workers Paid for
  apps that need it, and installs and updates skip the count of the account's cron
  triggers.
- On **Workers Free**, the install form asks **This account is on Workers Paid** for
  each app that needs Workers Paid, and offers it as an option for an app with cron
  triggers. Ticking it also offers **Remember this for the account**, which records
  Workers Paid as the **Workers plan** in **Settings > Your account**, unless the plan was detected.

The catalog page and the install form show how many cron triggers an app uses. The
update dialog shows it too when a new version adds cron triggers.

## What the install job does

Each step is a durable Workflow step, retried on its own if a Cloudflare API call
fails for a moment. The log shows every API call as `METHOD path -> status`.

1. Fetches the app's signed manifest from the catalog release and verifies its
   signature.
2. Checks the plan, the requirements, the Worker name, and that the account has room
   for the app's Workers (100 on Workers Free, 500 on Workers Paid). For apps that bind R2, it
   checks that R2 is enabled. For apps with cron triggers, it counts the cron
   triggers your other Workers use and stops if the app's own would take the account
   past the 5 Workers Free allows. The count is skipped when the account is on
   Workers Paid (see below).
3. Creates each KV namespace, D1 database, R2 bucket, queue, and Vectorize index the
   app binds, named `<worker-name>-<binding>` (lower case, `_` becomes `-`). It
   records each one as it goes. If a resource with that name already exists in the
   account, the install stops instead of adopting it. Hyperdrive configurations come
   first, and each Pipelines stream last, with its sink, pipeline and bucket (see
   [apps that stream events](#apps-that-stream-events)).
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
`notes` with an `api` Worker also gets `notes-api`. A Worker that only the app's other
Workers call can be kept off `workers.dev` by its catalog entry: it then has no
address at all and is not reachable from the internet.

On Workers Free an app may have at most three Workers: each one adds requests
to the install job, which the free plan limits to 50, so the manager refuses a
larger app there before creating anything. On Workers Paid an app may have up to
24. Each Worker counts toward the account's limit (100 Workers on Workers Free, 500
on Workers Paid), and the install stops before creating anything when the account
has no room for all of them.

The form asks for each secret and setting once. The manager sets it on the Workers
of the app that use it. Post-install steps and settings can mention any of the
Workers' addresses, filled in for this install.

The install job creates the app's resources first, one for each binding name: two
Workers that bind `DB` share one D1 database. It then deploys the Workers one at a
time, each after the Workers it binds to, with the app's own Worker as late as
possible. Each gets its own static assets, secrets, cron triggers, queue consumers,
and `workers.dev` address, except a Worker kept off `workers.dev`, whose address and
version previews stay off. D1 migrations run once all of them are deployed, and the
health check requests the app's own Worker.

The app's page lists the other Workers under Details, each with its address or a
note that it is not reachable from the internet, and each Worker under its
resources. [Updates and
rollbacks](/guides/updates/#apps-of-several-workers), [settings
changes](/guides/settings/), and [uninstalling](/guides/uninstall/) always cover
every Worker of the app.

## Post-install steps

When the install finishes, the app's page shows **Next steps** if the app has any:
where to sign in, which URL to point a client at, what to configure first. They can
mention the app's URL and Worker name, filled in for this install.

## Home

Home starts with **Needs attention**, shown only when something does, most urgent
first: a job that did not finish (**View log**), an app that is not responding
(**Check again**), updates, and anything your account still needs for apps you use
(**Set up**, or **Not needed** to hide it in this browser). The number beside **Home**
in the sidebar counts these rows.

Below it, **Your apps** shows a card for every install: its name, one line on how it is
doing, **Open** (the app itself, in a new tab) and **Manage** (its page in Appflare).
The sidebar lists the same apps under **Your apps**, with a dot when one needs
attention; the search icon beside the heading filters the list.

With no app installed, opening Appflare takes you to the catalog.

## The app's page

**Manage** opens an app's page. It shows its status, version,
health, resources, secret names, jobs, and the actions for
[updates and rollbacks](/guides/updates/), [changing settings and
secrets](/guides/settings/), and [uninstalling](/guides/uninstall/).

![Installed Short links app with its version, health and Open button](/screenshots/apps-installed-overview.png)
