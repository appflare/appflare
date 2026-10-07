---
"@appflare/manager": patch
---

A page left open at the workers.dev address while Appflare waits to move to its domain now follows it: it checks every 15 seconds, and once Appflare has moved it says so and opens the same page there (or offers a button, when a form on the page has unsaved input). The sign-in page says Appflare moved only to people who have not signed in at the new address yet, and the passkey offer after the move comes once per person: adding a passkey or choosing Not now ends it.

Reconnect with Cloudflare on an Appflare installed from a deploy page other than appflare.dev now comes back through that page's own callback.
