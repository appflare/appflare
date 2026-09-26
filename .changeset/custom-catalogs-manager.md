---
"@appflare/manager": minor
---

Add catalogs besides the official one. Settings > Catalogs lists the official catalog, which can be turned off but never removed, and the catalogs admins add. **Add a catalog** takes the catalog's index URL (https only), its public key as the catalog publishes it (the dialog shows each key's `SHA256:` fingerprint back to compare), a label and a colour. Before a catalog is added, the manager fetches its index, checks that it is a catalog index, and verifies one of its releases' signed manifests with the pasted key; if any check fails, nothing is added and the dialog says why. Editing a catalog's URL or key runs the same checks. A catalog cannot be removed while apps installed from it are still installed, because their updates and checks come from it; the dialog says so. A manager takes up to five added catalogs, and a pasted key may be neither an official key nor reuse an official key id. Changing a catalog's key or removing it drops everything cached for it.

Only prebuilt releases are installed from added catalogs. Their sandbox and self-deploying entries are left out of the catalog page (a banner counts them), and installs and updates of them are refused with "This catalog's index is not signed; only prebuilt releases are installed from added catalogs.", because those entries are trusted by the index alone and an added catalog's index is not signed yet. Signing the index is what would let them in later.

Keys are pinned per catalog: an added catalog's releases and form revisions verify with its own keys only, and the official catalog's always with the keys built into Appflare, so no catalog's key can vouch for another's apps. Verified manifests are cached per catalog for the same reason.

The catalog page lists the apps of every catalog that is on, with a source badge and a **Source** filter once there is more than one catalog; an app from an added catalog is addressed as `<catalog>:<slug>`, so two catalogs may list the same slug. Images, avatars, popularity and the sponsored slot come from the official catalog alone; an added catalog's apps show a monogram. **Refresh** and the scheduled run fetch every catalog that is on, one conditional request each, and record how each refresh went; one catalog that cannot be fetched or read never stops the others or the catalog page. An index or stats file larger than 4 MiB is refused.

Installs record the catalog they come from (existing installs are recorded as the official catalog's). Update checks, automatic updates, form revisions, the **Install checked** badge and update notifications follow that catalog only, and the app's page shows its source. Turning a catalog off hides its apps and stops update checks for apps installed from it until it is on again.

The daily usage report counts added catalogs and installs from them; it never includes their URLs, labels or app names.
