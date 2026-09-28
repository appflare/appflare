---
"@appflare/cf-api": patch
---

Add `access.updateApp` (`PUT /access/apps/{id}`), which replaces an Access application's settings, for example to move it to another hostname; `AccessApp` now lists the `policies` Cloudflare answers with.
