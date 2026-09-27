---
"@appflare/sandbox-worker": patch
---

The sandbox Worker tells Appflare that it builds static sites without Worker code, apps that install no packages, and apps with multi-line secrets, so Appflare can ask for a sandbox update instead of sending such an app to a sandbox Worker that cannot build it.
