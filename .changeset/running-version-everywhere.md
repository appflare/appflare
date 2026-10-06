---
"@appflare/manager": patch
---

The manager now takes its own version from its build everywhere, not from the `APPFLARE_VERSION` setting, which the Deploy to Cloudflare form lets anyone edit. On a manager whose setting was changed by hand, update checks, notifications, usage data and the sandbox connection check now use the real version; the connection check could fail on such a manager before.
