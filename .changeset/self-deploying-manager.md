---
"@appflare/manager": minor
---

Apps that ship their own installer can be installed, updated and uninstalled. The catalog shows them as "Self-deploying"; the install form asks for the Cloudflare token the app needs (created from the permissions its entry lists), the app's secrets and settings, and a confirmation of what a run costs on Workers Paid, and has no Worker name to choose: the installer names its Workers after the install's stage.

The install stores the token and the secret values as secrets on the sandbox Worker (never in the manager's database or logs), waits until the sandbox Worker serves them, has it run the installer's deploy command at the pinned commit, records every Worker and resource it reports as managed by the app's installer, and checks the main Worker's URL, counting any answer from the Worker itself as serving unless the entry says otherwise. An update runs the deploy again at the new pin, without a snapshot; rollback is refused with an explanation. An uninstall runs the installer's destroy command, fails if any of the app's Workers remain, marks the records deleted and removes the token and secrets from the sandbox Worker; Appflare never deletes such resources itself. The app's page shows how it was deployed, which resources the installer manages, and a card to enter the token or secrets again after a rotation or after the sandbox Worker was re-created. The job page shows the installer's output while it runs.

Every secret change on the sandbox Worker deploys a new version of it, which restarts its containers, so the manager refuses to store or delete an app's token or secrets there while another job that runs in the sandbox Worker is queued or running. A retried build or installer run asks for a fresh container.
