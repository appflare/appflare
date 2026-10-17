---
"@appflare/manager": patch
---

Fixed: On Workers Free, an install stops before changing anything when the account has no room for its cron triggers, D1 databases, Hyperdrive or Vectorize, and removes itself if its cron triggers are refused later.
