---
"@appflare/schema": minor
---

Catalog entries of the `self-deploying` tier describe the app's own installer under `install.selfDeploying`: the tool (`"alchemy"`), the deploy and destroy commands as argv, an optional `stageArg` (Alchemy's `--stage` by default), `stateStore: "cloudflare"`, and the Workers the installer creates, named with `{{stage}}` (the first one serves the app). The block is required for that tier and refused on every other, in the parser and in the published JSON Schema. Such an entry's index row carries a `build` block that points at its catalog manifest, like a sandbox tier entry.

The sandbox protocol gains the installer runs: `deploySelfManaged` and `destroySelfManaged` requests and results (the pinned commit, the commands, the install's stage, the environment variable names the app token and account id are exposed under, the app's settings and the names of its secrets, the Workers expected), a `selfManagedStatus` request and answer, and an `info().features` list with `"self-deploying"`. Requests never carry the token or secret values: the sandbox Worker holds them as its own secrets, named by `appTokenSecretName` and `appSecretSecretName`.

An app's own settings and secrets may not use `CLOUDFLARE_*` or `ALCHEMY_*` names, nor `BASH_ENV` or `ENV`, and neither a catalog entry's commands nor a run request may name the stage themselves (`--stage x` or `--stage=x`). Build requests take the same optional `attempt` as installer runs.
