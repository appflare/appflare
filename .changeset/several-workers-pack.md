---
"@appflare/pack": minor
---

The packer packs a catalog entry with `install.workers` into one format 2 artifact. It installs dependencies once, runs `install.buildCommand` and then each Worker's own build commands in the entry's order, reads every Worker's wrangler config, and bundles each Worker with its own dry run. The primary Worker's files keep the paths of a one-Worker artifact; every other Worker's modules and assets go under `workers/<name>/`. D1 migrations are recorded once per binding: Workers that bind one name must bring the same migration files or none.

Where a wrangler config names another Worker of the entry by its `name`, the packer records `{{workerName:<name>}}` instead: a service binding's `service` and a Durable Object binding's `script_name`, which the manager points at the installed Worker. It refuses a service binding to any Worker outside the entry, a Workflow bound from another Worker, two configs with the same Worker name, and Workers that bind each other in a cycle. A queue one Worker sends to and another consumes is recorded by its producer binding in both (`queueProducerBindings()`), so the install creates one queue. A Vectorize index the catalog declares must be bound by one of the Workers (`checkVectorizeDeclarations()`).

`verify` checks every Worker's modules and assets, and `--check-upload` applies to each Worker. `PackResult.workers` lists each Worker's module count, asset count and size, and `appflare-pack` prints one size line per Worker for such an app.
