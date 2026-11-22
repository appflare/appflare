---
"@appflare/installer": patch
---

Fixed: When Cloudflare refuses a deploy step, the message now carries Cloudflare's own explanation and error code instead of always blaming a missing permission, and a full D1 database allowance is named as such.
