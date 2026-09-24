---
"@appflare/manager": minor
---

The catalog page can be searched and filtered. The search box matches an app's name, summary, authors, the Cloudflare services it uses and its categories; filters narrow the list to installed or not installed apps, a Workers plan, a build tier and a category; the list sorts by popularity, name or the most recent install check. Search, filters and sort live in the page address, so a filtered list can be shared.

Every catalog card now has the same parts in the same order: icon (or a two-letter monogram when the catalog ships no icon), name, tier and plan; a two-line summary; authors and version; the install check, stars and installs; the services the app uses, always shown as icons, each marked available, not available or unknown for this account; and a footer with one installed badge ("Installed", "Installed ×2") and a Details button on every card. The services come from the app's signed manifest (bindings, cron triggers, requirements, Email Routing and the token permissions it asks for) and are read from the manifests Appflare already caches.

An app's page shows its details as a centred grid: version, license linked to a plain-language explanation (choosealicense.com, else the SPDX page), install check, popularity and links as icon buttons; the authors with their GitHub avatars and links to GitHub, X and their website; who packages it; and the services it uses with their availability. Avatars are served by Appflare itself at `/api/catalog/avatar/<login>`, only for authors the catalog lists, so the browser never contacts GitHub. The requirements warning lists only what this account is not known to offer, and when every requirement is detected there is nothing to confirm. The cover (when the catalog has one) and the screenshots show one at a time at a capped height, with previous and next buttons.

App icons fall back to the monogram everywhere they are shown, including when an image no longer loads.
