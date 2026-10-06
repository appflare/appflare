---
"@appflare/manager": patch
---

Installing an app now records the version of each of its Workers that Cloudflare actually serves. Setting a secret deploys a new version of a Worker, so an install that set secrets after the upload recorded a version that no longer served, and the first update or settings change warned that Cloudflare serves another version than Appflare recorded. The install now reads the serving version once after a Worker's last secret, one request per Worker that gets secrets. The install log no longer lists features of Appflare itself that a catalog entry asks for (such as per-Worker secret keys) as things the Cloudflare account must have, and the review of a build leaves them out too. A rollback's log now ends with its "Rolled back" line, followed at most by the line about a settings change it starts, instead of reads of the earlier version's settings that showed as bare "API calls" lines.
