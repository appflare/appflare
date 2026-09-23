---
"@appflare/schema": minor
---

Catalog index entries of the `sandbox` tier may omit `artifacts` and `digest` and carry a `build` block instead: the pinned commit, the URL and sha256 of the entry's published catalog manifest, and optionally the build command, the expected build minutes, and the container size. Artifact tier entries are unchanged and still require their artifacts. Adds `indexAppArtifact()` and `DEFAULT_EXPECTED_BUILD_MINUTES`.
