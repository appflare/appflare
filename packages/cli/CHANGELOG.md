# @appflare/cli

## 1.0.0

### Major Changes

- ca50f0d: The package is now only the installer: `create-appflare` installs the manager, prints its address, and honours `--version <x.y.z>`, `--artifact-dir`, `--name`, `--yes`, `--allow-unsigned` and `--no-telemetry` as before. `-v` (or `--version` without a value) prints the installer's version and `-h`/`--help` its options. The `appflare` bin is gone; `create-appflare` is the only one.
  
  The other commands are removed, because the manager now does each of their jobs itself:
  
  - `status`: **Settings > Appflare updates** shows the running version, the latest release, and whether an update is available.
  - `rollback`: the manager Worker's **Deployments** page in the Cloudflare dashboard, or `npx wrangler rollback --name <name>`, returns to an earlier version; neither needs the manager to be working.
  - `uninstall` (and `--purge`): **Settings > General > Remove Appflare** deletes the manager Worker, its Workflow, D1 database and KV namespace, and also the external domains gateway and the sandbox Worker.
  - `sandbox enable` and `sandbox disable`: **Settings > Account and capabilities > Sandbox builds** enables, updates and disables sandbox builds.
  
  Running one of the removed commands fails with a message naming its replacement. An install that fails after the deploy now prints the `wrangler` commands that delete what it created instead of pointing to `uninstall`. Usage data is sent for the install only, so the `command`, `install_id_known` and `purge` properties are gone. The library entry no longer exports the sandbox helpers (`sandboxEnable`, `sandboxDisable`, `buildSandboxWranglerConfig`, `explainSandboxDeployFailure`, `hasSandboxBindings`, `SANDBOX_CONTAINERS`, `SANDBOX_APP`, `SANDBOX_RELEASES`) or `splitCommand`.

### Minor Changes

- 49c9307: The installer sends anonymous usage data: one event when a command ends, with the command, its outcome, duration, the step it reached and an error category, the installer's version, the operating system, CPU architecture, Node.js major version, and whether it ran in CI or under a coding agent. Nothing is sent before a command ends, and it never sends the account, the Worker name, paths, user names or error messages. It prints a notice when a command starts. `--no-telemetry` on any command, or `APPFLARE_TELEMETRY=off` or `DO_NOT_TRACK=1` in the environment, turns it off; `create-appflare` then deploys the manager with `APPFLARE_TELEMETRY=off`, which keeps the manager's usage data off too. Otherwise the manager is deployed with the run's random install id (`APPFLARE_INSTALL_ID`), so its own usage data continues it.
- c7e02de: `create-appflare recover` gets a locked-out owner or admin back in. It uses your Cloudflare login, saves a fingerprint of a new one-time code on the manager Worker as the secret `RECOVERY_CODE_HASH`, and prints the code, which works once, for 30 minutes, under "Forgot your password?" on the sign-in page. `--email` makes the code work only for one admin. It sends no usage data.
- a799aed: Add `appflare sandbox enable` and `appflare sandbox disable`. `sandbox enable` deploys, or updates, the optional sandbox Worker `appflare-sandbox`, which builds sandbox tier apps in Cloudflare Containers in your account: it downloads the newest signed `sandbox@<version>` release (or `--version`, or `--artifact-dir`), verifies it like the manager's, and deploys it with wrangler from a temporary directory, creating two container applications that run `docker.io/mendylanda/appflare-sandbox:<version>` and the R2 bucket `appflare-builds`. The Worker has no public URL; the manager's support for it comes in a following release. On an account without Workers Paid it stops with "Sandbox builds need Workers Paid", and on one without R2 it says how to enable R2. `sandbox disable --yes` deletes the Worker and its container applications and keeps the bucket; `--purge` also empties and deletes the bucket after you type the sandbox Worker's name. Both refuse a Worker by that name that is not an Appflare sandbox Worker.
- c016f30: `create-appflare` no longer sets a `SETUP_TOKEN` secret or prints a secret setup link. It prints the manager's plain address and asks you to open it to finish setup, where you paste a Cloudflare API token for the account and create the owner. The installer declares the manager's new `version_metadata` binding, which the setup page uses to confirm that a pasted token belongs to the account the manager runs in, and refuses, before deploying anything, a manager release that lacks it (releases before manager 0.5.0, whose setup relied on the retired secret). `formatSetupUrl` and `generateSetupToken` are replaced by `formatManagerUrl`.

### Patch Changes

- 06adf84: `sandbox enable` checks the account with the same probes as the manager before anything is downloaded or uploaded: it stops when the account's subscriptions or Containers show Workers Free, when the credential lacks Containers, or when R2 was never enabled, and says which. A check that cannot tell (for example a login without billing access) never stops the deploy.
- 60797b3: When a release records `_redirects` or `_headers` rules for its assets, the installer writes them back as files in the assets directory for wrangler to read, rather than putting them in the generated wrangler config.
- 9d208b0: When it finishes, the installer prints the full addresses of the manager's Updates, Building apps and danger zone settings. The help text and the messages for removed commands give each page's address as well as its name.
- 9268399: Installs, updates, uninstalls, and Appflare's own updates no longer run out of
  the free plan's 50 subrequests on larger apps. Appflare now binds to itself
  (a `SELF` service binding) and runs each heavy piece of a job in a separate
  call with its own allowance: every asset upload part, the upload of the
  Worker's code, each D1 migration, and each page of objects deleted from an R2
  bucket. Buckets with many objects are emptied up to 720 objects per uninstall
  run; retry the uninstall to continue.
  
  New installs from `create-appflare` get the binding at once. An existing
  Appflare gains it with its next self-update after this one; until then it
  works as before.
- 995a658: `appflare sandbox enable` explains a refused container step and cleans up after a failed deploy. When wrangler's container application step fails with a bare "Unauthorized" or "Forbidden", the command now says Cloudflare refused access to Containers and names the causes: the account is not on Workers Paid, or, with an API token in `CLOUDFLARE_API_TOKEN`, the token lacks the Containers permission, with where to check each. The command checks access to Containers before it uploads anything, for an API token and a `wrangler login` alike, and stops there when Cloudflare refuses it. A failed deploy now rolls back what it created: the `appflare-sandbox` Worker when this run uploaded it and it did not exist before, with its container applications, and the `appflare-builds` bucket when the run created it and it is still empty. A Worker or bucket that was already there is kept, and the error says when the kept Worker may already run the new version. The error lists what was removed. `appflare sandbox disable` no longer reports deleting a Worker that was already gone. After a successful enable, the summary now points to the next step: connect the manager under Settings > Sandbox builds.
- b16d011: `appflare sandbox enable` now says first that sandbox builds can be enabled from the manager itself (Settings > Account and capabilities > Sandbox builds); the command keeps working for scripted setups.
- e737d12: The schema names the sandbox Worker's version metadata binding (`SANDBOX_VERSION_METADATA_BINDING`, `CF_VERSION_METADATA`), and the sandbox Worker's `info()` answer takes an optional `versionId`, the id of the version that answered, which the manager waits on after a secret change. `appflare sandbox enable` declares the version metadata binding when the release carries it, and still deploys releases without it. A CLI older than this one refuses sandbox Worker releases from now on, because it does not know the new `version_metadata` binding; that is intended (it would deploy them without it), and `npx @appflare/cli@latest sandbox enable` deploys them.
- 47ebd21: The help text and the messages for removed commands name the manager's new settings pages: Updates, Building apps, and the danger zone on Your account.
- 307d8cb: The usage data notice links to its page on appflare.dev.
- 8fec750: Uninstalling deletes Workflows by name. Cloudflare keeps a Workflow, with its instances, when the Worker that runs it is deleted, so `appflare uninstall` left the manager's Workflow behind and uninstalling an app left the app's. `appflare uninstall` now runs `wrangler workflows delete` for the manager's own Workflow after deleting the Worker, and the app uninstall job deletes each recorded Workflow after the Worker, counting one that is already gone as done. The "Remove Appflare" review now also says that the sandbox Worker's container applications stay and where to delete them.

## 0.1.0

### Minor Changes

- 5ae5577: `status` shows whether an update is available (`Update available: <version>` or
  `Up to date`) from the manager's health endpoint. `rollback --list` prints recent
  versions with their ids and dates for `--to`, and a rollback now ends with the
  manager's health and version. `uninstall` refuses a Worker that is not an Appflare manager, and
  `uninstall --purge` also deletes the D1 database and KV namespace the manager is
  bound to (by exact name only when the Worker is already gone), after you type the
  manager's name (or with `--yes --purge --i-understand-data-loss`). Release downloads explain a 404
  as a possibly private repository and how to pass `GITHUB_TOKEN`, fetch the files of
  a just-published release by id, and fall back to the previous complete release with
  a warning.
