---
"@appflare/cli": patch
---

When a release records `_redirects` or `_headers` rules for its assets, the installer writes them back as files in the assets directory for wrangler to read, rather than putting them in the generated wrangler config.
