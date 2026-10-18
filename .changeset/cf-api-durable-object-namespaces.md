---
"@appflare/cf-api": patch
---

Fixed: `client.workers.listDurableObjectNamespaces()` returns every namespace in an account of more than one page, and throws on an answer without the list instead of returning none.
