---
"@appflare/schema": minor
---

An artifact's Worker may record `exports` (the wrangler config's Durable Object and entrypoint exports, keyed by name) and `cacheOptions` (its `cache` block). Both are optional and loose, and an artifact that carries either is format 3 (`artifactFormatFor()`), so a manager that reads only formats 1 and 2 refuses it rather than install the Worker without them. `hasDurableObjectExports()`, `durableObjectExports()`, `sameWorkerExports()` and `sameDurableObjectExports()` go with them. An artifact whose Workers bind a Worker Loader (`worker_loader`, `WORKER_LOADER_BINDING_TYPE`) is refused unless its catalog manifest says `"plan": "paid"` (`workersPaidBindingProblem()`), because Cloudflare offers Worker Loader only on Workers Paid.
