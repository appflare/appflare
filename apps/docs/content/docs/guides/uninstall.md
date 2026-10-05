---
title: Uninstall an app
description: What an uninstall deletes, what you can keep, how to delete kept data later, and how to finish an uninstall that stopped.
---

Uninstall is in the **Danger zone** at the bottom of the **Overview** tab of the app's page, which only
admins see. Select **Uninstall**; the dialog lists everything the uninstall deletes
and asks you to type the Worker name to confirm.

## What is always deleted

For an [app that receives email](/guides/email-apps/#uninstalling), what the install
set up in Email Routing, first: its routing rules, the catch-all if it still points at
the app, and Email Routing itself if Appflare turned it on and nothing else uses it.

The app's [custom domains](/guides/custom-domains/), which the uninstall removes
first, each with its own request, so that no domain or DNS record is left pointing
at a deleted Worker. Its [external domains](/guides/external-domains/) go before
them, with the gateway's binding to the app's Worker; they stop answering at once,
and their owners can delete the DNS records they added. A domain holds no data, so
there is nothing to keep.

Next, the app's queue consumers: each queue the Worker reads from is detached from
it, before the Worker and before any queue is deleted. A kept queue stays in your
account without a consumer.

Then the Worker itself, and everything that only exists with it:

- its `workers.dev` route and cron triggers,
- its secrets,
- its Workflows,
- its Durable Object classes and everything they stored.

After the Worker, an [app that streams events](/guides/install-apps/#apps-that-stream-events)
loses its pipelines, sinks and streams, in that order. They hold no data: what a sink
wrote is in its R2 bucket, which you choose to keep or delete below. A bucket that is
kept keeps its R2 Data Catalog, so its tables stay readable. For a bucket that is
deleted, Appflare first removes its R2 Data Catalog, which needs the optional
**Workers R2 Data Catalog: Edit** permission on Appflare's token (no template link can
add it; add it by hand). Without it the bucket is still deleted, but Cloudflare keeps
the catalog's records of its tables; the uninstall log warns, and a later install
that creates a bucket of the same name clears them with the app's own token.

For an [app protected with Cloudflare Access](/guides/protect-apps/), the
application that keeps its public paths open goes first, before any address is
released. Its own Access application and service token go once the Worker and its
addresses are gone, so the app is never reachable without Access while the uninstall
runs.

For an [app of several Workers](/guides/install-apps/#apps-of-several-workers), the
uninstall deletes every Worker of the app this way, each with its queue consumers
detached first, before it deletes any resource.

## What you choose

Each data resource has a checkbox: KV namespaces, D1 databases, R2 buckets, queues,
and Vectorize indexes. All are ticked by default. Where Cloudflare exposes it, the
dialog shows what each holds, such as a KV namespace's key count or a D1 database's
size.

- **Ticked** resources are deleted with everything in them, one at a time after the
  Worker is gone. Each R2 bucket is emptied just before it is deleted, since
  Cloudflare only deletes an empty bucket.
- **Unticked** resources stay in your account. After the uninstall, the app's page
  lists them under **Kept in the account**, and the app is listed under
  [Removed apps](#removed-apps) until you delete what it kept or forget it. Appflare
  no longer uses them.

Deleting data is permanent.

## Removed apps

**Settings > Removed apps** lists every uninstalled app that still keeps
resources in your account, with what each one kept. An uninstalled app that kept
nothing is not listed. Admins have two actions for each app:

- **Delete retained data** deletes everything the app kept, with everything in it,
  after you type the Worker name to confirm. It runs as a job and opens its log. The
  one exception is an R2 bucket or Vectorize index whose name a newer install of the
  same Worker name now records: that resource belongs to the newer install, so it is
  left alone and no longer listed for the removed app. KV namespaces, D1 databases
  and queues have their own Cloudflare ids, so this cannot happen to them.
- **Forget** hides the app from Removed apps and deletes nothing. The resources stay
  in your account.

The same actions are in the **Danger zone** at the bottom of the removed app's own
page. After **Forget**, that page still lists what the app kept and still offers
**Delete retained data**.

## What is never touched

The uninstall only deletes resources recorded for this install. If no Worker is
recorded for it (for example, an install that failed before the upload), a Worker
with the same name is left alone.

## If an uninstall stops

An uninstall runs as a job, one step per resource. If a step fails, the install
stays in the uninstalling state and the **Danger zone** offers **Finish uninstalling**
with a **Retry uninstall** button. Resources
already deleted stay deleted; the retry continues with the rest.

A very large R2 bucket can take more than one run to empty. The job says so, and
**Retry uninstall** continues.

## Failed installs

An install that failed can be uninstalled the same way. This removes whatever it
had created, and frees its Worker name for a new install. **Install again** does this
for you, keeping nothing, and fills in the install form with the failed install's
choices; see [Installing apps](/guides/install-apps/).

## Installing again

After an uninstall, the Worker name is free and you can install the app again. Kept
resources still use their old names (`<worker-name>-<binding>`), and an install never
adopts an existing resource. To reinstall under the same Worker name, first delete
the kept resources with [Delete retained data](#removed-apps), or choose another
Worker name.
