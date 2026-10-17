---
"@appflare/cf-api": patch
---

Fixed: `client.d1.listDatabases()` returns every database in an account of more than one page, reading 1,000 per page until a short page or the reported total.
