---
"@appflare/manager": patch
---

List an app's account requirements on its catalog page with a sentence each, and ask the admin to confirm the account meets them before the Install button enables; installs started without that confirmation are refused. An install that needs an R2 bucket now checks that R2 is enabled before creating anything, and explains how to enable it (a payment method on file, even for the free tier) instead of showing Cloudflare's raw error.
