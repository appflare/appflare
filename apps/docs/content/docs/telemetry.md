---
title: Usage data
description: What leaving usage data on does, what Appflare sends and never sends, where it goes, and the ways to turn it off.
---

Appflare collects anonymous usage data to decide what to build and fix. It is on by
default and easy to turn off. The manager's first report goes out with its first
scheduled run after setup finishes. The home page then says that usage data is on
and how to turn it off, once, until an admin dismisses it; a manager updated from a
version without usage data shows the same notice. It never waits for an answer. A development build never sends anything.

## What it does for you

Every manager runs in someone's own Cloudflare account, where the maintainers cannot
see it. Usage data is how they find out what happens there. Leaving it on lets them:

- **Keep the versions you run working.** They see which versions of the manager are
  in use, so they know which ones to keep supporting and which upgrade paths to test
  an update against.
- **Fix what breaks, sooner.** They learn which install paths, apps and steps fail,
  and how often, so the most common failures get fixed first and updates break less
  often.
- **Work on what matters.** They see which features people use, such as passkeys,
  automatic updates or notification channels, so time goes where it helps most.

Turning it off changes nothing about how Appflare works for you.

## What is sent

Every event carries the Appflare version, whether it came from the manager or the
installer, and the random id described [below](#how-it-is-sent). Everything else is
a count, a yes or no, a version, a duration, or a value from a fixed list.

### Daily report (manager)

Once a day, the manager sends one report with:

- **Manager:** its database schema version, the Workers plan set in Settings (`free`,
  `paid` or unset), whether it uses Appflare's catalog or a custom one, days since
  setup, and whether a newer manager release exists.
- **Users:** how many users and admins there are, whether passkeys are in use, and
  how many users have one.
- **Features:** whether Cloudflare Access protection is on, whether the sandbox
  Worker is connected, whether Appflare and apps update automatically, and how many
  apps use the account setting for automatic updates or override it with on or off,
  and how many notification channels there are of each kind (Telegram, Slack,
  Discord, webhook).
- **Apps:** how many are installed, counted by status (installed, failed,
  installing, updating, uninstalling), by build type (prebuilt, sandbox,
  self-deploying), and by version age (current, or, when the catalog has a newer
  version, how long ago the running one was installed: under 7 days, 7 to 30, 30 to
  90, over 90 days); how many have a custom domain,
  Email Routing, or cron triggers; how many removed apps still keep data; and the
  catalog slugs of the installed apps, only for apps in Appflare's own catalog.

### Jobs (manager)

For each install, update, settings change, rollback, database restore, uninstall,
deletion of a removed app's kept data, build for review, manager self-update, and
manager rollback, one event when it starts and one when it ends, with:

- the kind of job, the app's catalog slug (`custom` for an app from a custom
  catalog or from a repository), the version it moves from and to (none for a custom
  catalog's app, an app from a repository, or an app built from source), the build
  type, where the app comes from (`catalog`, `repository` or `source`), and what
  started it (an admin, or the schedule for automatic updates); a manager rollback
  carries its kind only, never the versions it moves between. Nothing about a
  repository is sent: not its address, owner, name, branch or commit;
- when it ends: whether it succeeded, how long it took, and for a failure, its
  error category (such as `cloudflare_permission`, `plan_limit` or `d1_migration`),
  the phase it failed in (such as `resources`, `upload` or `health`), and, for a
  failed Cloudflare API request, the HTTP status and Cloudflare's numeric error
  code. The error text itself is never sent.

### Setup and use (manager)

- Once, after setup: how many minutes passed between connecting Cloudflare and
  creating the owner, and whether the manager continues the installer's id.
- At most once a day: that the manager was opened that day, and whether the first
  person to open it was an admin or a member.

### Installer

The installer sends one event per run, when the install ends:

- whether it succeeded, failed or was cancelled, how long it took, the last step it
  reached, and an error category (such as `wrangler_login`, `wrangler_deploy` or
  `health_timeout`);
- the installer's version, the operating system, CPU architecture and Node.js major
  version;
- whether it ran interactively, in CI, or with `--yes`; whether the Worker name was
  the default one; whether the login had several accounts; whether a wrangler login
  was needed; the coding agent it ran under, if any (such as `claude`, `codex` or
  `cursor`, from the variables those agents set).

## What is never sent

Your Cloudflare account id or name, email addresses, user names, Worker or instance
names, domains or URLs, secret or variable names or values, tokens, resource ids,
logs, error messages, or anything from a custom catalog, its app names and versions
included.

## How it is sent

Every event is tied to a random id created at install, never to a person. Setup
with the installer creates the id and hands it to the manager, so both report under
the same id. The manager sends from its Worker, not from your browser: there is no
tracking script, no cookie and no page view. The installer sends from your machine,
and gives up after 3 seconds so a run is never held up.

**Settings**, **Usage data**, **Preview** shows the next daily report, built the
same way the scheduled one is.

## Where it goes

Events go to [PostHog](https://posthog.com) Cloud in the EU region (Frankfurt), at
`eu.i.posthog.com`, as anonymous events: every event asks PostHog to create no
person profile and to skip its IP-based location lookup.

Two more protections are PostHog project settings, not something the code
enforces: the Appflare project is set to discard IP addresses, and events are kept
for as long as PostHog's plan retains them (a year on the free plan).

## Turning it off

Any one of these stops everything:

- The **Send anonymous usage data** switch under **Settings**, **Usage data**
  (admins).
- The installer's flag: `npx create-appflare --no-telemetry`.
- `APPFLARE_TELEMETRY=off` (`0` and `false` work too) or `DO_NOT_TRACK=1` in the
  installer's environment.
- The same variables on the manager's Worker, set in the Cloudflare dashboard under
  the Worker's **Settings**, **Variables and Secrets**. Either one locks usage data
  off: Settings shows the switch off and disabled, with "Turned off by the
  APPFLARE_TELEMETRY variable on this Worker. Remove the variable to change this
  here." (naming `DO_NOT_TRACK` when that is the one set), and the home page
  shows no usage-data banner after setup. Updates of the manager keep the variable.

When the installer's usage data is off by the flag or a variable, it deploys the
manager with `APPFLARE_TELEMETRY=off`, so the manager's is locked off too.

When it is off, nothing is sent, not even the fact that it is off. Turning it on
again continues with the same random id, and jobs that ran while it was off are not
reported.

## Wrangler's own metrics

The installer runs wrangler to deploy the manager. Wrangler has usage metrics and
error reports of its own, which go to Cloudflare. The installer turns both off for
every wrangler command it runs, whether Appflare's usage data is on or off, unless
you set `WRANGLER_SEND_METRICS` or `WRANGLER_SEND_ERROR_REPORTS` yourself.
