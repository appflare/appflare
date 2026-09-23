---
title: Uninstall an app
description: What an uninstall deletes, what you can keep, and how to finish one that stopped.
---

On the app's page, admins select **Uninstall**. The dialog lists everything the
uninstall deletes and asks you to type the Worker name to confirm.

## What is always deleted

The app's [custom domains](/guides/custom-domains/), which the uninstall removes
first, each with its own request, so that no domain or DNS record is left pointing
at a deleted Worker. A custom domain holds no data, so there is nothing to keep.

Then the Worker itself, and everything that only exists with it:

- its `workers.dev` route and cron triggers,
- its secrets,
- its Workflows,
- its Durable Object classes and everything they stored.

## What you choose

Each data resource has a checkbox: KV namespaces, D1 databases, R2 buckets, queues,
and Vectorize indexes. All are ticked by default. Where Cloudflare exposes it, the
dialog shows what each holds, such as a KV namespace's key count or a D1 database's
size.

- **Ticked** resources are deleted with everything in them, one at a time after the
  Worker is gone. Each R2 bucket is emptied just before it is deleted, since
  Cloudflare only deletes an empty bucket.
- **Unticked** resources stay in your account. After the uninstall, the app's page
  lists them under **Kept in the account**. Appflare no longer uses them; delete them
  in the Cloudflare dashboard when you no longer need the data.

Deleting data is permanent.

## What is never touched

The uninstall only deletes resources recorded for this install. If no Worker is
recorded for it (for example, an install that failed before the upload), a Worker
with the same name is left alone.

## If an uninstall stops

An uninstall runs as a job, one step per resource. If a step fails, the install
stays in the uninstalling state and the page offers **Retry uninstall**. Resources
already deleted stay deleted; the retry continues with the rest.

A very large R2 bucket can take more than one run to empty. The job says so, and
**Retry uninstall** continues.

## Failed installs

An install that failed can be uninstalled the same way. This removes whatever it
had created, and frees its Worker name for a new install.

## Installing again

After an uninstall, the Worker name is free and you can install the app again. Kept
resources still use their old names (`<worker-name>-<binding>`), and an install never
adopts an existing resource. To reinstall under the same Worker name, delete the kept
resources first, or choose another Worker name.
