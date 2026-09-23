---
title: Health checks
description: How Appflare checks that an installed app answers, and what each result means.
---

After an install, an update, or a rollback, the manager requests the app's URL to
see whether it answers. Most apps are checked at `/`. An app can name another path
in its catalog manifest (`install.healthPath`), for example `/api/health`.

## How the check runs

A new `workers.dev` route can take a little while to go live. The check therefore
tries for up to 90 seconds, waiting 2, 3, 5, 8, and then 10 seconds between
attempts. It retries on connection errors, on server errors, and on Cloudflare's
"not live yet" page (`error code: 1042`).

A plain 404 also retries, and counts as a pass when the 90 seconds are up. Many apps
serve nothing at `/`, and a 404 from the app still proves the Worker is running.

The check never fails the job. Everything was already created by then; the result is
recorded on the install.

## The results

| Badge | Status | Meaning |
| --- | --- | --- |
| **Verified** | `verified` | The Worker answered. |
| **Not verified yet** | `unverified` | The Worker did not answer within 90 seconds: the connection failed, or Cloudflare still reported the route as not live. The app may be fine; its route may still have been going live. |
| **Unhealthy** | `unhealthy` | The Worker answered with a server error (5xx). |
| **Not checked** | | No check has run yet. |

The app's page shows the result and when it was checked. **Installed apps** marks
installs that are not verified or unhealthy.

## Check again

On the app's page, admins can select **Check now**. It sends one request, with no
retries, and records the result. It is available when no job is running for the
app.

If an app stays **Not verified yet**, open its URL in a browser. If the page loads,
select **Check now**. If it does not, look at the app's logs in the Cloudflare
dashboard.
