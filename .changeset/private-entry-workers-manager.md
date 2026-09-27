---
"@appflare/manager": minor
---

A Worker that an app's catalog entry keeps off workers.dev never answers from the internet. Install leaves its workers.dev URL and version previews off, saying so explicitly right after the upload, and records no workers.dev route for it. Updates take it off before uploading a version that keeps it private, skip its preview check, and put it back on only after the version that wants it serves, or when the update fails before promotion; rollbacks do the same in reverse, and settings changes make sure it stays off. The app's page lists the app's other Workers under Details, each with its workers.dev link or a note that it is not reachable from the internet. Artifacts of format 4 are read.
