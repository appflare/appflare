---
"@appflare/cf-api": patch
---

Add the Containers calls needed to deploy a container-enabled Worker without wrangler: `containers.getApplication`, `createApplication`, `modifyApplication`, `deleteApplication`, `createRollout` and `getRollout`, with request and response types following wrangler's own Containers client. Add `workers.listDurableObjectNamespaces`, the `containers` field of script upload metadata, and `migration_tag` on listed Workers.
