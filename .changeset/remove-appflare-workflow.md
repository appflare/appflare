---
"@appflare/cf-api": minor
"@appflare/manager": patch
---

Removing Appflare from an account now deletes the manager's Workflow after its Worker. Cloudflare keeps a Workflow, with its instances, when the Worker that runs it is deleted, so the removal left it behind. `workflows.deleteWorkflow(name)` is new in `@appflare/cf-api`.
