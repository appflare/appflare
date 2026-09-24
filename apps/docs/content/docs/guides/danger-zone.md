---
title: Rotate the auth secret or remove Appflare
description: The two owner-only actions in Settings, General, Danger zone.
---

The **Danger zone** at the bottom of **Settings**, **General** holds two actions that
cannot be undone. Only the [owner](/guides/users/) can use them; other users see them
disabled. Each one asks you to confirm by typing, then opens a plain page with the
result.

## Rotate the auth secret

`BETTER_AUTH_SECRET` is the Worker secret the manager signs sign-in sessions with. The
installer sets it to a random value. Rotate it when you think it, or a session cookie,
may have leaked.

1. Select **Rotate auth secret** and read the warning.
2. Type `rotate` and select **Rotate and sign everyone out**.

The manager writes a new random value to its own Worker through the Cloudflare API.
That deploys a new version of the same code with the new secret, as saving the
Cloudflare token does. The value is never shown or logged. Then:

- **Everyone is signed out, you included.** Every session ends at once, and cookies
  signed with the old secret no longer work. Passwords and passkeys do not change, so
  everyone signs in again as before. The result page links to the sign-in page.
- **Notification channels need their credentials again.** Their credentials are
  encrypted with a key derived from this secret (see
  [Notifications](/guides/notifications/)). After a rotation each channel shows
  **Credentials unreadable** and sends nothing until an admin selects **Edit** and
  enters the bot token or webhook URL again. A webhook channel gets a new signing
  secret, shown once.

The Danger zone shows when the secret was last rotated from there. Rotation is refused
while Appflare is updating itself.

## Remove Appflare from this account

This removes the manager and everything it runs on, from the browser, without the
command line. The apps it installed stay.

1. Select **Remove Appflare**. The dialog reads the account and lists what will be
   deleted and what stays.
2. Type the Cloudflare account's name, as the dialog shows it, and select **Remove
   Appflare**.

Removal is refused:

- while any job is queued or running; wait for it to finish first.
- while any app still has an [external domain](/guides/external-domains/). Visitors of
  an external domain reach its app only through the gateway, which the removal
  deletes, so they would lose the site. The dialog names the apps and links to each
  one's **Domains and email** tab: remove the external domains there first. A gateway
  that serves no external domain is removed with the rest.

### What is deleted

In this order, each step one call to the Cloudflare API:

1. The sandbox Worker's R2 bucket `appflare-builds`, if the sandbox Worker is still
   there: first emptied, then deleted. Every build output and build log goes with it.
   A bucket kept after the sandbox Worker was removed on its own stays.
2. The [external domains](/guides/external-domains/) gateway, if you set one up: the
   route `*/*` on the gateway zone, the `appflare-gateway` Worker, the zone's fallback
   origin and the `appflare-gateway` DNS record if Appflare set them, and the gateway's
   KV namespace.
3. The [sandbox Worker](/guides/builds/) `appflare-sandbox`, if there is one, with the
   secrets it holds. That includes the token each self-deploying app's installer runs
   with: those apps keep running, but nothing can update or destroy them through their
   installer any more. Revoke their tokens in the Cloudflare dashboard if you no longer
   need them.
4. The manager's KV namespace, then its D1 database, with every user, passkey, job
   log, snapshot record, notification channel and setting.
5. The Cloudflare Access applications in front of the manager, if
   [Access protection](/security/) is on. They go after the database, so a removal
   that stops earlier leaves the manager protected. One that cannot be deleted at this
   point is named on the page; delete it under **Zero Trust**, **Access**,
   **Applications**.
6. Last, the manager Worker itself, with its Workflow, cron trigger and `workers.dev`
   address. It deletes itself after the result page has been sent. Once the database
   is gone it deletes itself even if you closed the page.

While the removal runs, no job starts, not even an automatic update.

The result page shows each step as it finishes and needs nothing from the manager, so
it stays readable after the manager is gone. If the manager Worker is still listed in
the dashboard a minute later, delete it there. If the sandbox Worker's container
applications are still listed under **Workers**, **Containers**, delete them there too.

### What stays

- Every app Appflare installed, with its Worker, databases, buckets, namespaces and
  secrets. They keep running, unmanaged: nothing updates them any more.
- Custom domains of apps, which keep serving them.
- The `Appflare` API token. Nothing uses it any more: revoke it in the Cloudflare
  dashboard, with any tokens you created for apps that you no longer need.

To manage the apps again later, reinstall Appflare with the installer from the
repository, as [Install Appflare](/start/install/) describes. The new manager starts
empty and does not know the apps already in the account.

### If a step fails

The page says which step failed and why, and whether Cloudflare Access protection is
still on. What was deleted stays deleted; the manager, its database and everything
after the failed step are still there, so Appflare keeps working and jobs can start
again. Fix the cause if the message names one, then run **Remove Appflare** again from
Settings. Steps that are already done are skipped. The same holds if you close the
page before the database is deleted: the removal stops where it was.

One run empties at most 720 objects from the build bucket. A bucket holding more stops
the first run with that message; run it again to continue.
