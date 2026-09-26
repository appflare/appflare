---
"@appflare/manager": minor
---

Install apps that keep their data in a PostgreSQL or MySQL database outside Cloudflare. The catalog marks them "Database elsewhere", shown as provided by you rather than as something the account offers. Their install form asks for a connection string per database and checks it as you type; the install job creates a Hyperdrive configuration from it (`<worker name>-<binding>`) before anything else is created, so a database Cloudflare cannot reach stops the install with Cloudflare's reason, and binds it to the app's Worker. The connection string is never stored: the job's record and log keep only the binding's name.

The app's Settings list its databases with the configuration each uses and offer "Replace connection string": the change creates a new configuration, uploads the app with it, checks the new version on a preview where Cloudflare allows it, and switches traffic; a change that fails before the switch deletes the new configuration again. The replaced configuration is kept, recorded as replaced, so rolling back to the version before the change still reaches its database (the rollback makes it the app's configuration again); the next successful update or settings change deletes it. Snapshots now record the Hyperdrive configurations their version binds: the Versions list marks a snapshot whose version binds a configuration deleted since as not available for rollback, with the reason, and a rollback to it is refused before anything is deployed (for a snapshot taken before this was recorded, the rollback reads the version's bindings from Cloudflare and refuses the same way). Uninstalling deletes an app's Hyperdrive configurations, never the databases. A token without the optional Hyperdrive: Edit permission gets a message naming it.

An update whose new version adds a database the installed version did not have is refused for now, with a message saying so: the update form cannot ask for the new connection string yet, so such a version needs a fresh install.

The Cloudflare token form lists the optional Hyperdrive: Edit permission for these apps.
