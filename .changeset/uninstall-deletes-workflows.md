---
"@appflare/cli": patch
"@appflare/manager": patch
---

Uninstalling deletes Workflows by name. Cloudflare keeps a Workflow, with its instances, when the Worker that runs it is deleted, so `appflare uninstall` left the manager's Workflow behind and uninstalling an app left the app's. `appflare uninstall` now runs `wrangler workflows delete` for the manager's own Workflow after deleting the Worker, and the app uninstall job deletes each recorded Workflow after the Worker, counting one that is already gone as done. The "Remove Appflare" review now also says that the sandbox Worker's container applications stay and where to delete them.
