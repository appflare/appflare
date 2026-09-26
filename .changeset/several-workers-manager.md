---
"@appflare/manager": minor
---

Apps of several Workers install, update, roll back, change settings and uninstall as one app. The primary Worker is the install's own Worker: its name, address, custom domains and health check are the app's. Every other Worker runs as `<Worker name>-<name>` on its own workers.dev address and is listed on the app page as a Worker.

- Install: resources first, each one once for every Worker that binds its name; then the Workers in the order their bindings to each other need (the primary as late as it can be), each with its own assets, secrets, cron triggers, queue consumers and workers.dev route; D1 migrations once; the health check on the primary. Bindings between the Workers and `{{workerUrl:<name>}}` / `{{workerName:<name>}}` are filled in with the installed names. Every Worker name is checked free before anything is created.
- Update: one snapshot for the app, which now records the version each other Worker serves (`snapshots.worker_versions_json`; the install records what its other Workers serve in `installs.worker_versions_json`; database upgrade 0021). Each other Worker's new version is uploaded and checked on its preview URL before the primary's, D1 migrations run before any promotion, then the Workers are promoted one by one with the primary last. Secrets a version introduces go to the Workers that get them. A version that adds a Worker is refused (its secrets cannot be copied); a Worker a version drops is left in place until the app is uninstalled.
  If an update or settings change fails after promoting other Workers but before the primary one, it puts them back on the snapshot's versions; one it cannot put back stays recorded, and a rollback to that snapshot is then offered even though the primary Worker already runs the snapshot's version.
- Rollback returns every Worker to the version the snapshot recorded, the primary last, with each Worker's cron triggers and queue consumers. A rollback across a Durable Object migration of any Worker is refused.
- On Workers Free an app may have at most 3 Workers: the install and update plans refuse more before anything changes, since each Worker adds requests to the one job and the free plan allows 50.
- Settings: a changed var or secret goes to the Workers that get it; each of them gets a new version, checked and promoted before the primary.
- Uninstall deletes every other Worker before the primary one.

What the app page, catalog page, install form and settings show (resources to create, services, cron triggers, email sending) now covers every Worker. Usage data reports how many Workers each install has, on job events and in the daily count of installs of several Workers.
