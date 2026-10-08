---
"@appflare/schema": minor
---

A catalog manifest takes two optional lists for the app's page. `features`: 3 to 6 plain lines saying what the app does for the person who installs it, each at most 100 characters, one line without leading or trailing spaces, no trailing period, each once (`appFeaturesSchema`, `MIN_APP_FEATURES`, `MAX_APP_FEATURES`, `MAX_APP_FEATURE_LENGTH`). `alternativeTo`: 1 to 5 names of well-known products or services the app can replace, such as "Google Analytics", each at most 40 characters, each once, and a name rather than a URL (`appAlternativesSchema`, `MAX_APP_ALTERNATIVES`, `MAX_APP_ALTERNATIVE_LENGTH`). Repeats are found ignoring case.

Like `tagline`, `licenseNote` and `authors`, both need no revision: they join `INDEX_ONLY_CATALOG_FIELDS`, and `REVISABLE_CATALOG_FIELDS` so a later revision may carry whatever copy is current. Index rows carry them as `features` and `alternativeTo`, written only when the manifest lists them; the row schema takes any non-empty strings there, so a later change to the manifest's limits cannot make a reader leave the app out. Managers from before this release strip both keys from manifests and index rows, as they strip any key they do not know; the packer and catalog checks refuse them until they run this release.
