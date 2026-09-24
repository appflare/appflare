---
title: Browse the catalog
description: What the catalog pages show before you install an app.
---

Open **Catalog** in the manager. The list comes from the catalog's `index.json`,
which the manager fetches every 30 minutes and caches. Admins can select
**Refresh** to fetch it now.

## The catalog card

Each app shows:

- **A plan badge.** **Free plan** means the app runs on the Workers free plan.
  **Workers Paid** means it needs the paid plan, usually because its Worker is
  larger than the free plan's 3 MB limit.
- **The version** the catalog offers.
- **Install checked** with a date: the last time the catalog's nightly job
  reinstalled this exact version into a test account and got an answer from it. A
  new version shows **Not checked yet** until its first check passes. A check that
  fails keeps the previous date, so an old date means recent checks failed. This is
  about the catalog's test account, not your installs; their own health is shown as
  **Verified** on each app's page (see [Health checks](/guides/health/)).
- **Requirements**, as icons, when the app needs more than Workers.
- How many times the app is installed in this account.

## The app page

Select **View and install** (or **Details** for an app you already have). The page
shows the version, the source repository, homepage, license, maintainers, and the
install check date under **Last checked**, and lists what the install will create: the Worker, plus each KV namespace, D1 database,
R2 bucket, queue, Vectorize index, and Durable Object class the app binds.

If you already installed the app, **Installed in this account** lists each install
with its Worker name and status.

### Requirements

When an app needs something beyond the free Workers plan, a **Before you install**
box lists it. Tick **This account meets these requirements** to enable the
**Install** button; apps that need Workers Paid also ask you to confirm the plan.
The manager cannot check most of these for you. R2 is the exception: the install
checks that R2 is enabled before it creates anything, except for a
[self-deploying app](/guides/builds/#self-deploying-apps), whose own installer
creates its resources.

| Requirement | What it means |
| --- | --- |
| R2 | R2 must be enabled on the account. Cloudflare asks for a payment method before enabling R2, even on its free tier. |
| A zone on this account | The account needs an active zone, a domain added to Cloudflare. |
| Email Routing | Email Routing must be enabled on a zone so email reaches the app's Worker. Appflare does not set Email Routing up for a self-deploying app. |
| Workers AI | The app runs models on Workers AI. Use beyond the daily free allocation needs Workers Paid. |
| Browser Rendering | The app drives a headless browser. The free plan allows limited browser time a day. |
| Containers | The app runs Containers, which need Workers Paid. For a [sandbox tier](/guides/builds/) app, the app is built in a container in your account instead; for a self-deploying app, its installer runs in one. Both need Workers Paid. |

### Apps that need their own token

Some apps call the Cloudflare API themselves, for example to update DNS records.
Their page shows **This app needs its own Cloudflare token**, with the permissions
it needs and why.

That token belongs to the app, not to Appflare. The manager never hands its own
token to an app. Select **Create token** to open a user API token form with the
permissions filled in, and narrow it to the accounts and zones the app needs.
Permissions the dashboard cannot prefill are marked **Add by hand**. When the
install form asks for the token, it is stored as a secret on the app's Worker;
otherwise the app's post-install steps say where it goes.

## Next

[Install an app](/guides/install-apps/).
