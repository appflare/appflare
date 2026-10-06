---
"@appflare/manager": patch
---

When the health check after a settings change or a change of Cloudflare Access protection cannot verify the app, its warning no longer says the route may still be going live: the app's address was serving before the change. A settings change's warnings also say the new settings are in place instead of "Everything was created". An install's warning is unchanged. The app page's "Not verified yet" hint no longer guesses that the route was going live, since a settings change or Check now can record it too; it says the last health check could not reach the app.
