---
title: Browse the catalog
description: What the catalog pages show before you install an app.
---

Open **Catalog** in the manager. The list comes from the catalog's `index.json`
(and from any catalogs an admin added, see [Custom catalogs](/guides/custom-catalogs/)),
which the manager fetches every 30 minutes and caches. Admins can select
**Refresh** to fetch it now.

## The catalog card

Each app shows:

- **Its icon**, when the catalog has one.
- **A plan badge.** **Free plan** means the app runs on the Workers free plan.
  **Workers Paid** means it needs the paid plan, because it uses features the
  free plan lacks.
- **The authors**: who wrote the app upstream.
- **The version** the catalog offers.
- **Install checked** with a date: the last time the catalog's nightly job
  reinstalled this exact version into a test account and got an answer from it. A
  new version shows **Not checked yet** until its first check passes. A check that
  fails keeps the previous date, so an old date means recent checks failed. This is
  about the catalog's test account, not your installs; their own health is shown as
  **Verified** on each app's page (see [Health checks](/guides/health/)).
- **Requirements**, as icons, when the app needs more than Workers.
- How many times the app is installed in this account.
- **GitHub stars and installs** across Appflare managers, when the catalog publishes
  them (see [below](#catalog-images-popularity-and-the-sponsored-slot)).

## The app page

Select **View and install** (or **Details** for an app you already have). The page
shows the version, the source repository, homepage, license, the app's authors with
links to their website, GitHub, and X profiles, the catalog maintainers who package it
under **Packaged by**, and the install check date under **Last checked**, and lists what the install will create: the Worker, plus each KV namespace, D1 database,
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
creates its resources. Analytics Engine is checked too: while the account check
finds it off, the install is refused. Turn on Analytics Engine once in the
dashboard, then choose **Re-check** in **Settings › Account and capabilities**.

| Requirement | What it means |
| --- | --- |
| R2 | R2 must be enabled on the account. Cloudflare asks for a payment method before enabling R2, even on its free tier. |
| A zone on this account | The account needs an active zone, a domain added to Cloudflare. |
| Email Routing | Email Routing must be enabled on a zone so email reaches the app's Worker. Appflare does not set Email Routing up for a self-deploying app. |
| Workers AI | The app runs models on Workers AI. Use beyond the daily free allocation needs Workers Paid. |
| Browser Rendering | The app drives a headless browser. The free plan allows limited browser time a day. |
| Analytics Engine | The app writes events to Workers Analytics Engine. It is off on an account until you open its page in the dashboard once, and Cloudflare refuses to deploy the app until then. |
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

## Catalog images, popularity and the sponsored slot

### Images

A catalog entry can have an icon, shown on its card, and a cover image (1200 by 630
pixels) and up to 8 screenshots, shown on its page. The manager serves every image
itself, at `/api/catalog/media/<sha256>`. It fetches an image only when the catalog
index it has cached lists it, on the catalog's own site, and serves it only when its
bytes match the sha256 the index gives. Your browser never contacts the catalog site
or a sponsor to show an image.

### Popularity

Next to its index, the catalog publishes numbers it rebuilds about every hour: the
stars of each app's upstream repository on GitHub, and how many Appflare managers run
the app or installed it in the last 30 days, counted from anonymous
[usage data](/telemetry/). Counts below 10 are not published; cards show them as
**Fewer than 10**. A manager with usage data turned off is not counted, and still
sees the numbers.

When recent numbers exist, the catalog page offers **Sort by**: **Most popular** (the
default) lists first the apps running on the most managers, then those installed most
in 30 days, then the most starred, with apps that have no numbers last. **Name** sorts
alphabetically. Numbers older than 72 hours are not shown, and the page keeps the
catalog's own order. Popularity only orders and labels the list; nothing else
depends on it.

### The sponsored slot

The catalog index has a slot for sponsored content, in every release from the first
one, empty while there is no sponsor. When it holds something, the catalog page shows
one item above the list, labelled **Sponsored**, with **Sponsored by** and the
sponsor's name. The label is part of the manager, not of the catalog, so no catalog
can take it off. The information button next to it says what the item is:

- **An app in the catalog.** It was checked like every other app. Being sponsored
  changes nothing else: not its place in the list, its sorting, or its numbers.
- **Anything else**, such as a sponsor's own product. Appflare has not checked what
  it links to.

Select **Hide** (the close button) to hide an item for yourself. Other users still
see it until they hide it too. If the index has another active item, that one takes
its place.

The sponsored slot never tracks you. Its image is served by the manager like every
other catalog image. Its links open in a new tab with `noreferrer`, so the sponsor
does not learn your manager's address, and nothing is added to them. Nothing about
the item, whether you saw it, clicked it or hid it, leaves the manager, and it is
not part of usage data.

## Next

[Install an app](/guides/install-apps/).
