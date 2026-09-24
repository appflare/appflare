---
"@appflare/cf-api": patch
---

Add two read-only account probes: `probeWorkersDev` (`GET /workers/subdomain`; code 10007 means no workers.dev subdomain is registered) and `probeZeroTrust` (`GET /access/organizations`; a 404 means the account has no Zero Trust organization yet), and `probeAccountSetup` for both. A 401 or 403 is reported as the token lacking the permission. The capability client now carries `workers.getAccountSubdomain` and `access.getOrganization`.
