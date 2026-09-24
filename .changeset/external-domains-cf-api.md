---
"@appflare/cf-api": minor
---

Add Cloudflare for SaaS custom hostnames as `customHostnames`: `quota` (answers only when Cloudflare for SaaS is on for the zone), `list`, `get`, `create` (a DV certificate validated by `http` or `txt`), `delete`, and the zone's fallback origin (`getFallbackOrigin`, `setFallbackOrigin`, `deleteFallbackOrigin`), with the refusal codes as constants: `CUSTOM_HOSTNAMES_NOT_ENABLED` (1404), `FALLBACK_ORIGIN_NOT_GRANTED` (1456), `CUSTOM_HOSTNAME_DUPLICATE` (1406) and `FALLBACK_ORIGIN_NOT_SET` (1551). Also new: `zones.createDnsRecord`, `zones.deleteDnsRecord`, `zones.createWorkerRoute`, `zones.deleteWorkerRoute`, `kv.putValue` and `kv.deleteValue`.
