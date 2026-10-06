---
"@appflare/schema": minor
---

A config patch may drop `mtls_certificates` (`"mtls_certificates": null`), which Appflare cannot install, since a certificate is uploaded to one account with its private key, and may drop a top-level key the packer's wrangler does not know (`"email": null`). The packer refused both before with no way for a catalog entry to leave them out. Managers from before this release refuse an artifact whose config patch drops either, so an entry that needs one installs only on managers that run this release.
