---
"@appflare/cf-api": minor
---

Add account capability probes, also as their own entry `@appflare/cf-api/capabilities`: `probeR2` (one-bucket list; Cloudflare's code 10042 means R2 was never enabled), `probeContainers` (container application list by name; a refusal that names Workers Paid means the plan, any other 401 or 403 means the token's permissions), `probeWorkersPlan` (the account's subscriptions, which need "Billing: Read"; a `workers_paid` entry in force means Workers Paid, none means Workers Free, a contract plan without one cannot be told), `probeAccountCapabilities` for all three, and `detectedWorkersPlan`. Each probe is a read call, never throws, and says why when it cannot tell. New client calls: `billing.listSubscriptionsPage`, `containers.listApplications`, and `r2.listBucketsPage`.
