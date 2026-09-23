---
"@appflare/pack": minor
"@appflare/schema": minor
"@appflare/manager": minor
---

An app may now have a service binding to its own Worker, such as the `WORKER_SELF_REFERENCE` binding OpenNext uses for caching and revalidation. The packer records a `services` entry whose `service` is the wrangler config's own `name` as `{ type: "service", name, service: "self", entrypoint? }`, since an install may run under another Worker name. Any other service binding fails the pack with a message naming the binding: one pointing at another Worker, or a self binding that sets `environment`, `props`, or `cross_account_grant`. `appflare-pack verify` refuses such bindings too.

The manager accepts the self binding and uploads it pointing at the install's own Worker, so several instances of the app each call themselves, and an app that binds only to itself installs under any Worker name unless its catalog entry sets `install.fixedWorkerName`. Every other service binding is still refused when the install or update is planned, before anything is created, even in an artifact edited by hand: a binding to another Worker could reach another install, or the manager and the job units it runs with its account-wide API token.

The artifact schema types the self binding (`selfServiceBindingSchema`, with `service` restricted to `"self"`) and adds `isSelfServiceBinding` and `serviceBindingProblem`. Artifacts without service bindings are unaffected. Update Appflare before installing an app whose artifact has a self binding: an earlier manager refuses every service binding, so the install stops at its plan without creating anything.
