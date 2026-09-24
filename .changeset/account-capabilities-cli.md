---
"@appflare/cli": patch
---

`sandbox enable` checks the account with the same probes as the manager before anything is downloaded or uploaded: it stops when the account's subscriptions or Containers show Workers Free, when the credential lacks Containers, or when R2 was never enabled, and says which. A check that cannot tell (for example a login without billing access) never stops the deploy.
