---
"@appflare/cf-api": minor
---

Add `versions.patchLatestVersion()`, which creates a Worker version from the latest one with a JSON merge patch (`PATCH /workers/workers/<name>/versions/latest`), for example to add one binding without uploading the code again.
