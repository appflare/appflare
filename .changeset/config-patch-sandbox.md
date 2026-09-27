---
"@appflare/sandbox-worker": patch
---

The sandbox image's packer applies a catalog entry's config patch, and `info().features` lists `config-patch`. A sandbox build refuses a malformed patch before the container starts, and a catalog app built from source is inspected with its catalog manifest (`appflare-pack inspect --manifest`), so a config wrangler only reads patched no longer fails detection.
