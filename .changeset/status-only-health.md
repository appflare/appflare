---
"@appflare/schema": minor
"@appflare/manager": minor
---

Apps behind Cloudflare Access or their own sign-in can be marked healthy. The catalog manifest takes an optional `install.healthMode`: `"default"` (as before) or `"status-only"`. An app whose every route, its health path included, needs credentials cannot show without them whether it works, and some answer such a request with an error of their own. With `"status-only"`, any answer the app's Worker gives itself counts as verified, a server error included, in the check after an install, update, or rollback, in the check of a new version before it serves, and in "Check now". Connection failures and the "not live yet" page (`error code: 1042`) are still retried, and a page Cloudflare serves because the Worker crashed still counts as a server error. Redirects, 401, and 403 answers already counted as verified in the default mode.
