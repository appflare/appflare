---
"@appflare/manager": patch
---

Turning an app's Cloudflare Access protection off no longer ends with "health: not verified yet (Cloudflare Access asked for a sign-in)" for an app that serves. Access goes on asking for a sign-in for a few seconds after its application is deleted, so the health check now waits that out, within its usual 90 seconds, and its warnings speak of the protection being turned on or off instead of "Everything was created". The last line of a settings change or a change of protection names the app's address, as an install's does, instead of the health check's URL.
