---
"@appflare/cf-api": patch
---

`zones.listDnsRecords` also lists every record whose name ends in a suffix (`{ nameEndsWith }`, Cloudflare's `name.endswith` filter), and the assets config type names `_redirects` and `_headers`.
