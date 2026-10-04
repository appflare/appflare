---
"@appflare/manager": patch
---

A custom domain added a moment ago shows "Being set up" while Cloudflare still attaches it and issues its certificate, instead of "Unhealthy" with HTTP 530 (or another of Cloudflare's own error pages). The app page keeps checking it on its own until it answers, for up to 15 minutes after it was added. A domain that has served the app before still shows a 530 as unhealthy.
