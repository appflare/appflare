---
"@appflare/pack": minor
---

The packer checks a Worker against Appflare's upload budget instead of its module count, so a framework build of hundreds of modules packs and installs. A pack now fails, writing nothing, when a Worker's modules add up to more than 32 MiB or would take more Range requests than one upload may make (`workerUploadProblem` from `@appflare/schema`); before, it only warned. `PackResult.warnings`, `packWarnings`, `workerTooLargeMessage` and `MAX_WORKER_SIZE_BYTES` are removed, as the refusal covers them.

`appflare-pack verify --check-upload` fails an artifact whose Worker does not fit one upload. `--max-modules <n>` is deprecated: it still runs the same check, ignores `<n>`, and prints a note saying so.

`WorkerSize` carries `ranges`, the Range requests the modules are read with; `workerSize()` takes the modules' layout in the zip as its second argument. The size line reads, for example, `579 modules in 2 ranges, 11.44 MiB of at most 32.00 MiB (gzip 2.86 MiB, not limited)`, and `workerSizeLine()` no longer takes a module limit. The package re-exports `workerUploadCost`, `workerUploadProblem`, `MAX_WORKER_UPLOAD_BYTES` and `MAX_WORKER_UPLOAD_SUBREQUESTS` in place of `MAX_WORKER_MODULES`.
