---
"@appflare/pack": minor
---

A wrangler config that declares `mtls_certificates` fails the pack with a message naming the config patch that drops it (`{ "mtls_certificates": null }`), like the other sections Appflare cannot install. The packer used to record the binding, which the manager then refused, and no catalog entry could leave it out.
