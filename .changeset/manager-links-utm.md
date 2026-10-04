---
"@appflare/manager": patch
---

Links from the manager to appflare.dev (the docs links, the Documentation and version links, Usage data's "What is sent", "Use this Appflare on appflare.dev", the reinstall guide and the Access recovery link in notifications) carry `utm_source=appflare-manager` with the name of the link, so the site's analytics can count visits that come from Appflare. They still send no referrer and never say which Appflare a visitor came from.
