---
"@appflare/manager": minor
---

GitHub access tokens ask only for what they are used for. When adding a token, choose **Builds of private repositories**, **Appflare release downloads**, or both. The repositories a token covers are now optional: a build token that names none is used for any private repository, and one that names repositories is used only for those (`owner/repo`, `owner/*`, separated by commas, checked when given). When several tokens fit a repository, the most specific is tried first. A token only for release downloads needs no repositories and is never sent for a build.

"Appflare release downloads" now explains itself: while Appflare's own repository on GitHub is private, updating Appflare needs a token that can read its releases, and that token needs only read-only access to the contents of `appflare/appflare`.

The token list says in plain words what each token is used for, such as "Builds of acme/*" or "Appflare release downloads", and "Not used" for a token whose only use moved to a newer one. Existing tokens keep their repositories and are still used for builds, now only of the repositories they name, and the one used for release downloads stays so (database upgrade 0024).
