---
"@appflare/manager": minor
---

Apps of several Workers can run a Workflow that another of their Workers defines. The install creates the Workflow with the Worker that defines it, which is uploaded first, records it right after that upload, and points the other Worker's binding at it; updates, settings changes and rollbacks keep the same order, and the uninstall deletes the Workflow once, by name, after the Workers. A Workflow binding to a Worker outside the app is still refused. The job's budget now counts the Workflows each of the app's other Workers defines.
