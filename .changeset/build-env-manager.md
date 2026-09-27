---
"@appflare/manager": minor
---

When an install or update creates a Vectorize index whose app declares metadata indexes, Appflare creates them right after the index, one step each, before the app writes a vector. When it creates an R2 bucket whose app declares lifecycle rules, it sets them on the bucket beside Cloudflare's default rule for unfinished multipart uploads. Appflare reads artifacts of format 6, which carry these settings.

A sandbox build of an app that uses build-time constants, an install without devDependencies, Vectorize metadata indexes or R2 lifecycle rules is refused on a sandbox Worker that predates them, with how to update it, rather than built without them.
