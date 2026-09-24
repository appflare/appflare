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
32-character value that you can copy, replace, or regenerate. Copy it before you
install. It is shown only on this form and cannot be read back afterwards.

**Settings.** Variables on the app's Worker, for example a home page URL. A setting
starts with the app's default. When the default names the app's own address, the
form shows it filled in for the Worker name you typed, and the install fills in the
real workers.dev address (also when you attach a custom domain later). Only settings
you change are stored; the others follow the app's default on each update. Settings marked JSON take a JSON value, such as `["inbox@example.com"]`,
and the form checks it before you can install.

Select **Install**. The manager starts an install job and opens its live log.

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
**Account capabilities**, marked **Detected**. It checks when the token is saved, once a
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

If a step fails, the job stops and names the step. Everything created so far stays
recorded. Nothing is deleted automatically. To try again, [uninstall](/guides/uninstall/)
the failed install, which removes what it created, and install again.

## Post-install steps

When the install finishes, the app's page shows **Next steps** if the app has any:
where to sign in, which URL to point a client at, what to configure first. They can
mention the app's URL and Worker name, filled in for this install.

## The app's page

**Installed apps** lists every install. An app's page shows its status, version,
health, resources, secret names, jobs, and the actions for
[updates and rollbacks](/guides/updates/), [changing settings and
secrets](/guides/settings/), and [uninstalling](/guides/uninstall/).
