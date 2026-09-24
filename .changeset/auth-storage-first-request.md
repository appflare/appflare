---
"@appflare/manager": patch
---

Fix sign-in, session reads and setup hanging forever on a freshly deployed manager. Better Auth creates its request storage after a lazy `import("node:async_hooks")` that it starts when its modules first load. On Workers that import belongs to whichever request loaded the routes first, often the health check or the footer's version, and when that request ended before the import settled, every later auth request in the isolate waited on it until the next deployment. The Worker now creates Better Auth's storage itself on the first request, kept alive with `waitUntil`, and remembers only success. Derived notification keys are likewise cached only once finished.
