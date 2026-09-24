---
"@appflare/manager": patch
---

The catalog list and an app's page take an app's services and categories from its index row when the catalog publishes them, so the list reads no manifest from KV and fetches none from GitHub. Rows of an older index still fall back to cached manifests, fetched a few per view after the response. The services are worked out by `@appflare/schema`, the same code the catalog runs.
