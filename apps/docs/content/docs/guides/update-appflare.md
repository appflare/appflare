---
title: Update Appflare
description: How the manager updates itself, and how to go back.
---

The manager checks its release feed,
[github.com/appflare/appflare/releases](https://github.com/appflare/appflare/releases),
every 30 minutes. It only considers complete, published releases with a valid
signature.

## Update from Settings

Open **Settings** and find the **Appflare** card. It shows the running version, the
latest release, and when it last checked. Admins can select **Check now** to look
for a release right away.

When a newer release exists, select **Update Appflare to &lt;version&gt;** and confirm. Only
newer versions are offered.

The self-update job:

1. Verifies the release's signature and that it is a manager release.
2. Takes a snapshot of the running version and a Time Travel bookmark of the
   manager's D1 database.
3. Uploads the new version next to the current one. The current version keeps
   serving.
4. Checks the new version at its preview URL. It must report the new version number
   and a working database. This first request also applies the new version's
   database migrations, which are always additive, so the running version keeps
   working with them.
5. Switches all traffic to the new version.

No other job runs during a self-update, and a self-update does not start while
another job runs.

## Update automatically

Under **Settings**, **Automatic updates**, admins can turn on **Automatically update
Appflare**. It is off by default. The cron then starts the same self-update when a
newer release is known and no other job is queued or running. It does not try a
release again after its self-update failed.

## Go back

The Settings page only offers newer versions. To return to an earlier one, use
either of these. Both work even if the manager's UI does not load.

- From your computer:

  ```sh
  npx @appflare/cli rollback
  ```

  See [Command line](/guides/cli/#rollback). `@appflare/cli` is not on npm yet;
  until it is, run `node packages/cli/bin/appflare.js rollback`
  [from a checkout](/start/install/#from-a-checkout).
- In the Cloudflare dashboard, open the `appflare` Worker, go to **Deployments**, and
  roll back there.

A rollback changes the Worker only. The manager's database stays as it is.
