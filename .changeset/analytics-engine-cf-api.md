---
"@appflare/cf-api": patch
---

Add `probeAnalyticsEngine`, which runs `SHOW TABLES` through the Analytics Engine SQL API (`POST /accounts/{id}/analytics_engine/sql`, read-only): an answer means Analytics Engine is on; the SQL service's plain-text 403 means it was never turned on; a refusal carrying a Cloudflare error code is the token's permissions. `probeAccountSetup` now runs it with the workers.dev and Zero Trust probes. The client gains `analyticsEngine.sql`, and `ANALYTICS_ENGINE_NOT_ENABLED_CODE` (10089) names the code Cloudflare refuses a Worker upload with while Analytics Engine is off.
