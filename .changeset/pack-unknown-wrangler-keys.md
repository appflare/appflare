---
"@appflare/pack": minor
---

The packer refuses a wrangler config that sets a top-level key it does not know, naming the key, where wrangler would drop it with no more than a warning and the app would run without it. That covers keys from wranglers newer than the packer's (`k2`, `analytics`) and keys wrangler never had. When the app works without the key, a catalog entry drops it with its config patch (`"email": null`); the packer accepts such a drop only for a key the config sets and the packer does not know.
