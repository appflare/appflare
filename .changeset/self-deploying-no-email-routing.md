---
"@appflare/schema": patch
---

The catalog manifest now refuses `install.emailRouting` on `self-deploying` entries, in the parser and in the JSON Schema. Such an app's own installer deploys it and Appflare sets up no Email Routing for it, so the install form would have asked the admin to choose a zone that nothing uses. `artifact` and `sandbox` entries still take it.
