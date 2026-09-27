---
"@appflare/manager": minor
---

Apps of up to 24 Workers install, update and roll back on Workers Paid. Before anything changes, the install and update jobs estimate the Workflow steps, requests and unit calls the app's Workers add to the one job and refuse a job that would pass Workers Paid's 10,000 steps or requests (or Workers Free's 1,024 steps); the job log records the estimate. Each Worker's upload, assets, promotion and address stay steps of their own, and each upload is still checked on its own budget. Workers Free keeps its limit of three Workers per app.

The install now counts the account's Workers, with the Worker list it already reads, and stops before creating anything when the app's Workers would not fit: 100 per account when the account is detected or set to Workers Free, 500 otherwise (an account with 100 Workers or more is on Workers Paid).

A rollback that fails before the app's own Worker is rolled back now returns the app's other Workers it already moved to the versions they served, so the app runs one version again; a Worker that cannot go back is recorded as serving the snapshot's version, and the job log says which.
