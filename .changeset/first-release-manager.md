---
"@appflare/manager": minor
---

The first public release of Appflare, a self-hosted app manager that runs as one Worker in your own Cloudflare account. It installs apps from the Appflare catalog, creates the databases, storage and other resources each app needs, and keeps the apps updated, with rollback to an earlier version. Before anything reaches your account, it checks the signature of every release it installs and the hash of every file in it. Apps can move to your own domains and be removed again together with the resources they created. Several people can share one manager, the manager itself can sit behind Cloudflare Access, and it updates itself from its own signed releases.
