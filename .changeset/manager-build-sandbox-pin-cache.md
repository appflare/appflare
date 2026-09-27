---
"@appflare/manager": patch
---

A sandbox Worker version bump now invalidates the cached manager build, so a rebuilt manager always pins the sandbox release of its own commit instead of the previous one.
