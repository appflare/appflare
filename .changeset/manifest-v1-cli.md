---
"@appflare/cli": major
---

The installer reads manager releases in the v1 artifact format only: the D1 SQL of each binding under `d1[binding]`, no top-level `source`, and `worker.wranglerConfig` always present. A release of a later format fails with `the release is artifact format <n>, and this installer reads format 1; run the latest installer (npx create-appflare@latest)`. Releases in the earlier formats no longer install. `_redirects` and `_headers` rules are still written back into the assets directory, and a release without Worker code is still refused.
