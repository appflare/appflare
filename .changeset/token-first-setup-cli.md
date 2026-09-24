---
"@appflare/cli": minor
---

`create-appflare` no longer sets a `SETUP_TOKEN` secret or prints a secret setup link. It prints the manager's plain address and asks you to open it to finish setup, where you paste a Cloudflare API token for the account and create the owner. The installer declares the manager's new `version_metadata` binding, which the setup page uses to confirm that a pasted token belongs to the account the manager runs in, and refuses, before deploying anything, a manager release that lacks it (releases before manager 0.5.0, whose setup relied on the retired secret). `formatSetupUrl` and `generateSetupToken` are replaced by `formatManagerUrl`.
