---
"@appflare/installer": minor
---

The hosted installer: an API that deploys a signed Appflare release into a visitor's own Cloudflare account with the short-lived access token their browser sends with each request. Each request does one bounded step and records progress, so a closed tab can continue later; names and hostnames already in use are refused, and removal deletes only what the installation created.
