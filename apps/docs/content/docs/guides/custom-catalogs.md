---
title: Custom catalogs
description: Add catalogs besides the official one, browse them together, and what changes for apps that come from them.
---

The manager lists apps from the official Appflare catalog. An admin can add more
catalogs: a company's internal apps, a community collection, or your own. A custom
catalog works like the official one. It publishes an `index.json` and a signed
release for each app, and the manager installs and updates its apps the same way.

Only prebuilt releases are installed from a catalog you add. An app that a
custom catalog lists as built in your account or as self-deploying is left out of
the **Catalog** page, and installing or updating it is refused: "This catalog's
index is not signed; only prebuilt releases are installed from added catalogs." A
release is signed with the catalog's key, but those entries are trusted by what
the index says, and a custom catalog's index is not signed yet. Signing the index
is what would allow them later.

The difference is who you trust. Every artifact from a custom catalog must be
signed with that catalog's own key, which you paste in when you add it. Appflare's
maintainers do not review the apps in a catalog you add, so add only catalogs whose
owner you trust.

## The catalogs list

Open **Settings > Catalogs**. The list shows the official catalog, labelled
**Official**, and every catalog you added, each with its label and colour, its
index URL, the key ids and fingerprints of its keys, and how many apps are installed
from it. Members see the list; only admins change it.

Each catalog has a switch. Turning a catalog off hides its apps from the
**Catalog** page and stops update checks for apps installed from it, until you
turn it back on. Nothing is uninstalled. The official catalog can be turned off
too, but never removed. It is always verified with the keys built into Appflare.

## Add a catalog

Select **Add a catalog** and fill in:

- **Index URL**: the address of the catalog's `index.json`. It must start with
  `https://`.
- **Public key**: the line the catalog publishes for this, which looks like
  `{"keyId":"...","publicKeyBase64":"..."}`. Paste it exactly. During a key change
  a catalog may publish a list of up to four such keys in square brackets; paste
  the whole list. The dialog shows each key's fingerprint back (`SHA256:...`).
  Compare it with the fingerprint the catalog's owner published, somewhere you
  already trust, before you save. A key may not be one of the official catalog's
  keys, nor reuse one of their key ids.
- **Label**: the name shown on the catalog's apps, such as `Acme internal`.
- **Colour**: the colour of that label.

When you select **Check and add**, the manager fetches the index, checks that it is a valid catalog
index, and verifies the signature of one released app's manifest with the key you
pasted. Only then is the catalog added. If the index cannot be fetched, is not a
catalog index, or the signature does not verify, the catalog is not added and the
dialog says why. A manager takes up to five added catalogs.

## Browse apps from several catalogs

The **Catalog** page lists the apps of every catalog that is on, together. Each
card, and each app's page, shows a source badge with the catalog's label and
colour (the catalog page shows them once you have added a catalog). Use the
**Source** filter to show one catalog's apps only. **Refresh** fetches every
catalog that is on; the cron does the same every 30 minutes, with one request per
catalog that costs nothing when its index has not changed.

Apps from a custom catalog show a monogram instead of an icon, cover or
screenshots, and no GitHub stars or install counts. The sponsored slot never shows
an item from a custom catalog. Images, popularity and the sponsored slot come only
from the official catalog (see [Browse the catalog](/guides/catalog/)).

## Apps installed from a custom catalog

An install remembers the catalog it came from, and its page shows that source
under **Source**.
Updates, form revisions and the **Install checked** badge come from that catalog
only.

Signatures stay separate the same way. An app from a custom catalog must verify
with that catalog's key; the official keys never verify it. The official
catalog's apps must verify with the official keys; a custom catalog's key never
verifies them.

## Edit or remove a catalog

Select **Edit** on an added catalog to change its **Label**, **Colour**, **Index
URL** and **Public key**. When you change the index URL or the key, the manager
runs the same checks as when you added it before it saves the change.

**Remove** is refused while any app installed from the catalog is still
installed: their updates and checks come from that catalog, and its key verifies
them. [Uninstall](/guides/uninstall/) those apps first, or turn the catalog off
instead.

## Usage data

If [usage data](/telemetry/) is on, it counts how many custom catalogs the manager
has and how many installs come from them. It never includes their URLs, labels, or
the names of their apps.

## Run your own catalog

The official catalog's repository doubles as a template: copy it, generate a key,
and its workflows sign and publish your apps. See
[Run your own catalog](https://github.com/appflare/catalog/blob/main/TEMPLATE.md).

## Next

[Install an app](/guides/install-apps/).
