---
"@appflare/cf-api": minor
---

Add zone and Workers custom domain calls: `zones.listZones` (every page, filtered by account, status, or name), `zones.getZone`, `zones.listDnsRecords` (records at one exact name), `zones.listWorkerRoutes`, and `workerDomains.listDomains`, `attachDomain` (with `overrideExistingDnsRecord`), and `detachDomain`, plus the error codes Cloudflare answers when a hostname has other DNS records (`DOMAIN_DNS_RECORD_CONFLICT`) or already serves another Worker (`DOMAIN_ORIGIN_CONFLICT`).
