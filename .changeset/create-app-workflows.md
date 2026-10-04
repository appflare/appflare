---
"@appflare/manager": patch
---

Create the Workflows an app defines. Uploading a Worker never creates its Workflows, so apps that start one (OpenSEO's site audits, for example) failed with "Workflow does not exist". Installs now create each Workflow for the Worker that defines it right after that Worker's upload, updates create new ones and update kept ones once the new version serves, and rollbacks put them back on the old version's class. Apps installed by earlier versions get their missing Workflows created by the next scheduled check, and the app page marks a Workflow that does not exist yet.
