---
"@appflare/manager": minor
---

Appflare can be deployed with the Deploy to Cloudflare button, from the public repository `appflare/deploy`, which every manager release now refreshes with the prebuilt release (no build step, no service binding to itself, no secrets declared). A manager deployed that way carries `APPFLARE_INSTALL_SOURCE=deploy-button`, and its home page shows admins a "Clean up the deploy copy" card until one of them dismisses it: a link to the Worker's settings in the dashboard to disconnect Workers Builds, a search for the private copy of the repository on GitHub to delete it, and why it matters (a push to the copy deploys its old version over the current one). Every manager now also notices, when an isolate starts, that it is older than its database (after a dashboard rollback or a redeploy of an old build) and says so on the home page, with a link to Settings, Appflare updates.
