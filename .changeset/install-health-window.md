---
"@appflare/manager": patch
---

The health check at the end of an install, update, or rollback now keeps
probing for up to 90 seconds with backoff (2, 3, 5, 8, then every 10 seconds),
since a new workers.dev route can take longer than 20 seconds to go live. It no
longer fails the job: everything is already created or promoted by then, so the
job succeeds, logs a warning when the Worker could not be verified, and records
the result on the install (verified, not verified yet, or unhealthy for a 5xx).
A plain 404 passes once the window ends, as apps may serve 404 at their root.
The install job now probes the catalog's `install.healthPath` like the update
job does. The install page shows the health with the time of the last check and
a "Check now" button for admins; the installed list flags installs that are
unhealthy or not verified yet.
