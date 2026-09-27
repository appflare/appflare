---
"@appflare/pack": patch
---

An entry that keeps one of its Workers off workers.dev (`install.workers[].workersDev: false`) is packed as artifact format 4, which older managers refuse.
