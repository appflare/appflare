---
"@appflare/cli": major
---

The package is now only the installer: `create-appflare` installs the manager, prints its address, and honours `--version <x.y.z>`, `--artifact-dir`, `--name`, `--yes`, `--allow-unsigned` and `--no-telemetry` as before. `-v` (or `--version` without a value) prints the installer's version and `-h`/`--help` its options. The `appflare` bin is gone; `create-appflare` is the only one.

The other commands are removed, because the manager now does each of their jobs itself:

- `status`: **Settings > Appflare updates** shows the running version, the latest release, and whether an update is available.
- `rollback`: the manager Worker's **Deployments** page in the Cloudflare dashboard, or `npx wrangler rollback --name <name>`, returns to an earlier version; neither needs the manager to be working.
- `uninstall` (and `--purge`): **Settings > General > Remove Appflare** deletes the manager Worker, its Workflow, D1 database and KV namespace, and also the external domains gateway and the sandbox Worker.
- `sandbox enable` and `sandbox disable`: **Settings > Account and capabilities > Sandbox builds** enables, updates and disables sandbox builds.

Running one of the removed commands fails with a message naming its replacement. An install that fails after the deploy now prints the `wrangler` commands that delete what it created instead of pointing to `uninstall`. Usage data is sent for the install only, so the `command`, `install_id_known` and `purge` properties are gone. The library entry no longer exports the sandbox helpers (`sandboxEnable`, `sandboxDisable`, `buildSandboxWranglerConfig`, `explainSandboxDeployFailure`, `hasSandboxBindings`, `SANDBOX_CONTAINERS`, `SANDBOX_APP`, `SANDBOX_RELEASES`) or `splitCommand`.
