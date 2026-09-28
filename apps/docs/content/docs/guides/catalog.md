---
title: Browse the catalog
description: What the catalog pages show before you install an app.
---

Open **Catalog** in the manager. The list comes from the catalog's `index.json`
(and from any catalogs an admin added, see [Custom catalogs](/guides/custom-catalogs/)),
which the manager fetches every 30 minutes and caches. Admins can select the
refresh button at the top right to fetch it now. The line under the search field
says how many apps there are and when the list was last updated; hover over the
time for the exact date.

Appflare does not use an app's Deploy button: it installs a signed build of the
pinned commit and keeps it updated.

You can look through every app before you install Appflare, too: the
[apps page](/apps/) of this site lists the whole catalog.

## Search and filters

Type in the search field to find apps by name, by what they do, by author, or by a
Cloudflare service they use (such as `D1` or `R2`). The filter button at the end of
the field narrows the list by plan (**Free** or **Paid**), by license (see
[Licenses](#licenses)), to apps installed in this account, and, once you have added
a catalog, to one catalog. Each active filter shows as a pill inside the field,
such as **Category: Email** or **Plan: Free**: select its **×**, or press Backspace
at the start of the field, to remove it. The **×** at the end of the field clears
the words and every filter.

Under the field, the categories show as cards with the number of apps in each.
Select a card to show that category's apps, and select it again to show every app.

The search and filters are part of the page address, so you can bookmark or share a
filtered view, for example `/catalog?category=email&plan=free` or
`/catalog?installed=1`.

## Rows and tiles

Without a search or filter, the page shows rows of apps:

- **New this week**: apps added to the catalog in the last seven days. While the
  catalog does not say when apps were added, this row is **Recently tested** and
  shows the apps whose latest version passed the catalog's test most recently.
- **Most popular**: the apps running on the most Appflare managers, then the most
  starred on GitHub (see [Popularity](#popularity)).
- **Installed on this account**.
- One row for each of the biggest categories.

Each row has **See all**, which lists every app of the row, and arrows to scroll it
(on a phone, swipe instead). With the keyboard, the Left and Right arrow keys move
between the apps of a row. **All apps** below the rows lists every app by name.

Each app shows its icon, name and a one-line description, then its plan (**Free**
runs on the Workers free plan, **Paid** needs Workers Paid; hover for the full plan
name), its GitHub stars when the catalog publishes them, and one button: **Get**
opens the app's page, where installing starts, and **Manage** opens the app you
already installed.

## The app page

Select an app, or **Get**, to open its page. It shows **Install checked** with a
date: the last time the catalog's nightly job reinstalled this exact version into a
test account and got an answer from it. A new version shows **Not checked yet**
until its first check passes. A check that fails keeps the previous date, so an old date means
recent checks failed. This is about the catalog's test account, not your installs;
their own health is shown as **Verified** on each app's page (see
[Health checks](/guides/health/)).

The page
shows the version, the source repository, homepage, license (with a line on what it
allows), the app's authors with
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
dashboard, then choose **Check again** in **Settings > Your account > What this account can run**.

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
Their install form explains how to create that token right next to the field that
takes it: **Create token** opens a user API token form with the permissions already
selected, and **Permissions it needs** lists each one and why. Narrow the token to
the accounts and zones the app needs. A permission the form cannot select says why
on its own line. When an app takes the token later instead, the explanation sits at
the end of the form and the app's post-install steps say where it goes.

That token belongs to the app, not to Appflare. The manager never hands its own
token to an app. When the install form asks for the token, it is stored as a secret
on the app's Worker. Once the app is installed, its **Settings** tab keeps **Create
token** and the permissions: next to that secret when you give it a new value, or
in a section of its own for an app that takes the token in its own setup steps. A
self-deploying app shows them on its **App token** card.

## Licenses

The catalog lists apps whatever their license and never leaves one out for it. It
shows the license the app's own repository declares, so the choice is yours:

- **An open-source license**, such as **MIT** or **AGPL-3.0-only**, is shown by its
  id. On the app's page each id links to a plain explanation of it.
- **A source-available license**, such as **BUSL-1.1**, **FSL-1.1-MIT**, a PolyForm
  license, **Elastic-2.0** or **SSPL-1.0**, is marked **Source-available**. The code
  is public, but the license restricts some uses, often production or commercial
  use. The catalog entry can add a short note on what is restricted; hover over the
  badge to read it.
- **No license** means the repository publishes none. You may run the app, but
  you have no license to modify or redistribute it.
- **Custom license** means the app has a license of its own with no standard id;
  its page links to the file.

The license filter in the search field's filter menu narrows the list to
open-source, source-available, or unlicensed apps.

## Catalog images, popularity and the sponsored slot

### Images

A catalog entry can have an icon, shown wherever the app is listed, and a cover image (1200 by 630
pixels) and up to 8 screenshots, shown on its page. The manager serves every image
itself, at `/api/catalog/media/<sha256>`. It fetches an image only when the catalog
index it has cached lists it, on the catalog's own site, and serves it only when its
bytes match the sha256 the index gives. Your browser never contacts the catalog site
or a sponsor to show an image.

### Popularity

Next to its index, the catalog publishes numbers it rebuilds about every hour: the
stars of each app's upstream repository on GitHub, and how many Appflare managers run
the app or installed it in the last 30 days, counted from anonymous
[usage data](/telemetry/). Counts below 10 are not published; app pages show them
as **Fewer than 10**. A manager with usage data turned off is not counted, and still
sees the numbers.

The **Most popular** row, and search and filter results, list first the apps running
on the most managers, then those installed most in 30 days, then the most starred,
with apps that have no numbers last. Numbers older than 72 hours are not shown: the
**Most popular** row is left out and results keep the catalog's own order.
Popularity only orders and labels the list; nothing else depends on it.

### The sponsored slot

The catalog index has a slot for sponsored content, in every release from the first
one, empty while there is no sponsor. When it holds something, the catalog page shows
one item as a single line after the first row, labelled **Sponsored**, with the
sponsor's name. The label is part of the manager, not of the catalog, so no catalog
can take it off. The information button next to it says what the item is:

- **An app in the catalog.** It was tested like every other app. Being sponsored
  changes nothing else: not its place in the list, its order, or its numbers.
- **Anything else**, such as a sponsor's own product. Appflare has not reviewed what
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
