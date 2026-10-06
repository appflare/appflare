---
title: FAQ
description: Free plan limits, health check results, R2 and payment methods, and removing Appflare.
---

## Does Appflare work on the free plan?

Yes. The manager itself runs on the Workers free plan, and most catalog apps do too.
Each app's catalog card shows **Free plan** or **Workers Paid**.

## Which free plan limits matter?

| Limit on Workers Free | What it means for Appflare |
| --- | --- |
| 50 subrequests per invocation | The manager installs apps from a Workflow, which runs its steps in one invocation until it sleeps for 5 minutes. It reads a Worker's modules with one request per 8 MiB of adjacent modules, so the number of modules does not matter, and it uploads at most 32 MiB of modules per Worker, which one upload holds in memory at once. A job for an app of several Workers that needs more than 50 requests pauses for 5 minutes and continues in a fresh invocation. |
| 64 MiB Worker size, uncompressed (on every plan) | No plan difference: Cloudflare no longer limits the compressed size. Appflare's own cap is lower, 32 MiB of module bytes per Worker, because one upload holds them all in memory. |
| 5 cron triggers per account | The manager uses one (every 30 minutes). Apps with cron triggers share the other four. The catalog page says how many an app uses, and an install stops before it creates anything if the account would pass 5. The count is skipped when the account's Workers plan (detected, or chosen in **Settings > Your account > What this account can run**) is Workers Paid, or when you tick **This account is on Workers Paid** for that install or update. |
| 10 D1 databases per account | The manager uses one. Each app that binds D1 uses one per database, per install. |

Other free plan quotas, such as requests per day and KV writes per day, apply to
your apps as usual. The manager keeps its own use low: job logs go to D1, not KV,
and the job page polls only while a job runs.

## Why does a health check say "Not verified yet"?

The manager requested the app's URL for 90 seconds after the install and never got
an answer. Either the connection failed, or Cloudflare still answered that the new
`workers.dev` route was not live yet. New routes can take a little while to
propagate, so this usually means the check ran too early, not that the app is
broken.

Open the app's URL. If it loads, select **Check now** on the app's page. See
[Health checks](/guides/health/).

## Why does an install ask for a payment method?

Apps that store files in R2 need R2 enabled on your account. Cloudflare asks for a
payment method before it enables R2, even though R2's free tier costs nothing. The
install checks for R2 before it creates anything and stops with a message if R2 is
not enabled. Enable it in the Cloudflare dashboard under **R2 Object Storage**, then
install again.

## Can I install the same app twice?

Yes, under different Worker names, unless the app only works under one fixed name.
See [Install an app](/guides/install-apps/#several-installs-of-one-app).

## Can I pick an older version of an app?

No. Installs and updates use the catalog's current version. After an update you can
[roll back](/guides/updates/#roll-back) to the version you had.

## What happens to my apps if the manager breaks?

Nothing. Installed apps are ordinary Workers in your account and do not depend on
the manager at runtime. To repair the manager, roll it back under **Settings >
Updates > Recent versions**. If its pages do not load, roll it back from the
Worker's **Deployments** page in the Cloudflare dashboard, or with
`npx wrangler rollback --name appflare`. See
[Roll back](/guides/update-appflare/#roll-back).

## How do I remove Appflare entirely?

1. In the manager, [uninstall](/guides/uninstall/) each app you want to remove, with
   the resources you do not want to keep ticked. Removing the manager first leaves
   the apps running with nothing tracking them.
2. Note any resources you kept. Each app's page lists them under **Kept in the
   account**; after the next step, nothing lists them. Delete them in the Cloudflare
   dashboard when you no longer need them.
3. As the owner, open **Settings > Your account > Danger zone** and select
   **Remove Appflare**. It deletes the manager Worker, its Workflow, its D1 database and
   its KV namespace, and also the external domains gateway and the sandbox Worker with
   its build bucket. See
   [Rotate the auth secret or remove Appflare](/guides/danger-zone/#remove-appflare-from-this-account).
4. In the Cloudflare dashboard, revoke the `Appflare` API token, and any tokens you
   created for apps. If Appflare connected with Cloudflare sign-in instead, the removal
   withdraws it; see [Withdraw Appflare's access](/guides/cloudflare-connection/#withdraw-appflares-access)
   to check.
