---
"@appflare/schema": minor
---

Artifacts can carry a Worker that serves static assets only (a wrangler config with `assets` and no `main`): its `worker.mainModule` is omitted and `worker.modules` is empty. `artifactFormatFor` gives format 5 for such an artifact, as for a D1 baseline, so a manager that reads only formats 1 to 4 refuses it with the message to update Appflare. The artifact schema refuses such a Worker when it has no static assets, or has bindings (vars included), catalog secrets or vars that go to it, Durable Object migrations or exports, cron triggers, queue consumers, an assets binding, `run_worker_first`, or the observability, placement, limits or cache settings wrangler does not send for it; it also holds `mainModule` and `modules` together. `isAssetsOnlyWorker` and `assetsOnlyWorkerProblems` are exported.

`install.installDirs` may be an empty list, which installs nothing: for a repository without a `package.json`, whose Worker wrangler bundles from relative imports alone. The JSON Schema is regenerated.
