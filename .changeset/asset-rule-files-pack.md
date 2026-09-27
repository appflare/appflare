---
"@appflare/pack": patch
---

The `_redirects` and `_headers` files at the root of a Worker's assets directory are recorded in the artifact's `assets.config`, as wrangler sends them with every upload, so redirects and custom headers work after an install. They are still not packed as assets. A symlinked one is skipped with a log line, so a pack never reads a file outside the checkout, and one over 512 KiB (far more than the rules Cloudflare applies) is refused.
