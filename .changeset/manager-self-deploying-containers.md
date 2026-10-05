---
"@appflare/manager": patch
---

Enabling or updating sandbox builds now also creates the sandbox Worker's container applications for the installers of self-deploying apps, which run apart from builds because the sandbox Worker refuses build containers' requests addressed to `api.cloudflare.com`; disabling sandbox builds, or removing Appflare from the account, deletes them with the others. The sandbox card no longer speaks of two container applications, and when Appflare's token cannot delete them the removal review names all four.
