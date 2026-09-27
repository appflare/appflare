---
"@appflare/schema": minor
---

A Worker's upload is budgeted by what it costs, not by its module count. Cloudflare has no module count limit; what binds one upload is the free plan's 50 subrequests per invocation and the memory that holds every module at once. `workerUploadCost(modules)` counts the subrequests an upload spends reading the modules from a release asset (the redirect, then one Range request per span of adjacent modules), and `workerUploadProblem(modules, subject)` explains why a Worker cannot be uploaded: more than `MAX_WORKER_UPLOAD_SUBREQUESTS` (42) subrequests, or more than `MAX_WORKER_UPLOAD_BYTES` (32 MiB) of modules. `rangeReadCost(ranges)` gives the cost of a known number of ranges.

The span planning the manager reads artifacts with (`planSpans`, `SpanBuilder`, `byOffset`, `SPAN_LIMITS`, and the `ArtifactSpan`, `SpanFile` and `SpanLimits` types) now lives here, so the packer and the manager plan the same ranges.

`tooManyModulesMessage` is removed. `MAX_WORKER_MODULES` stays for one release, deprecated and no longer used as a limit, because tools built against the previous release read it by name.
