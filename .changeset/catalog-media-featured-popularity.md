---
"@appflare/schema": minor
"@appflare/manager": minor
---

Catalog images, a sponsored slot, and popularity. Each index row may carry `media`: an `icon`, a 1200x630 `cover` and up to 8 `screenshots` (with alt text), each an https URL on the catalog site pinned by the sha256 of its bytes. The index gains `featured`, the sponsored slot (always written, empty while there is no sponsor), and an optional `stats` URL pointing at the catalog's `stats.json`: GitHub stars per app and install counts from anonymous manager events, with counts below 10 published as null. Adds `indexMediaSchema`, `featuredItemSchema`, `isFeaturedItemActive()`, `catalogStatsSchema` and `MIN_PUBLISHED_INSTALLS`.

The manager shows app icons on catalog cards and the cover and screenshots on an app's page. Images are served by the manager itself at `/api/catalog/media/<sha256>`, only when the cached index lists them on the catalog's own origin and their bytes match the digest, so a user's browser never contacts the catalog site or a sponsor. The catalog page shows the first active sponsored item, always labelled "Sponsored", with links opened `noreferrer`; each user can hide an item (new `featured_dismissals` table). The catalog sorts by popularity when recent numbers exist (numbers older than 72 hours are hidden) and shows GitHub stars. The cron fetches the index and the stats file with `If-None-Match`, keeping each ETag as KV metadata of the cached copy, and rewrites a cached copy only when it changed.
