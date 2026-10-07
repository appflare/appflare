# @appflare/pack

## 0.3.0

### Minor Changes

- bfb0d36: The packer accepts `{{emailDomain}}` and `{{emailZoneId}}` in the wrangler config's vars and service binding props of an entry with `install.emailRouting`, refuses them in any other, and checks placeholders in a JSON var's keys as well as its values.
- 03b5bd1: A wrangler config that declares `mtls_certificates` fails the pack with a message naming the config patch that drops it (`{ "mtls_certificates": null }`), like the other sections Appflare cannot install. The packer used to record the binding, which the manager then refused, and no catalog entry could leave it out.
- 03b5bd1: The packer refuses a wrangler config that sets a top-level key it does not know, naming the key, where wrangler would drop it with no more than a warning and the app would run without it. That covers keys from wranglers newer than the packer's (`k2`, `analytics`) and keys wrangler never had. When the app works without the key, a catalog entry drops it with its config patch (`"email": null`); the packer accepts such a drop only for a key the config sets and the packer does not know.
- f6cab63: The packer keeps `props` on a service binding to the app's own Worker or to another Worker of its entry, as `wrangler deploy` sends them, and checks the placeholders in their strings like a var's (`servicePropsPlaceholderProblems`); props that are not a JSON object are refused. A config patch can set vars to text and add a Workers AI binding.
- f71f0b9: The packer keeps a Workflow's `limits`, `concurrency`, `schedules` and `default_retention` from the wrangler config, recording them in the artifact as `worker.workflowSettings` beside the unchanged binding (`collectWorkflowSettings`), so the manager creates the Workflow with the settings `wrangler deploy` would give it. A field of `limits`, `concurrency` or `default_retention` that wrangler does not know is left out, and the pack log says so (`unknownWorkflowSettingFields`). A pack fails when a binding that runs another Worker's Workflow sets any of them (`WorkflowSettingsError`), as `wrangler deploy` does, and, before building, when a Workflow runs on a schedule and the catalog manifest does not say `"plan": "paid"`. A Workflow binding whose `script_name` is its own Worker's name is now recorded without it in an app of one Worker too, so the manager creates that Workflow instead of refusing the binding.

### Patch Changes

- bfb0d36: `{{emailDomain}}` and `{{emailZoneId}}` are now refused in an entry without `install.emailRouting`, in var defaults, config patches, post-install notes and the wrangler config's vars and service binding props. Before, they were not placeholders and were passed to the app as written; an entry that used that text for its own purposes must rename it or receive email.
- 03b5bd1: A wrangler config's own `build.command` runs in the config's directory, as it does when an app runs `wrangler deploy` beside its config, instead of at the repository root. Wrangler runs a custom build in the directory it was started in, so a command such as `npm run build` in a config below the root failed to find its `package.json`, and catalog entries replaced it with `build: null` and an `install.buildCommand`. Those entries keep working.
- 03b5bd1: The packer records each Worker module with the type `wrangler deploy` would upload it as, read from the upload wrangler's dry run writes (`--outfile`), instead of guessing from the file extension. A wrangler config's module `rules` now decide the type as they do for wrangler: with a `Text` rule for `**/*.md` or `**/*.svg`, an imported file reaches the Worker as a string, where the packer used to record it as data and the Worker got an ArrayBuffer. Module names and bytes are unchanged. A Worker in the service-worker format (`addEventListener`) now fails the pack with a message saying so; Appflare could not install one before either.

## 0.2.0

### Minor Changes

- 1fa72de: Apps of several Workers built by the Cloudflare Vite plugin now pack. A Workflow binding whose `script_name` names another Worker of the entry is recorded as `{{workerName:<name>}}` instead of failing the pack, and one naming its own Worker is recorded without it. A Worker whose config the build generated for an auxiliary Worker (listed in the redirect's `auxiliaryWorkers`) is packed from that generated config: name its own config (`wrangler.audit.jsonc`) and the packer finds the one generated from it. A generated config read without the redirect is read without `legacy_env`, which older plugin versions write and wrangler accepts only through the redirect. A config patch on a config the build generated now applies to that config after the build, as long as it does not change `main`, `assets.directory` or `build`; `wrangler deploy --dry-run` and wrangler's reader now take the config the packer wrote with `--config`.

## 0.1.0

### Minor Changes

- 346d608: The first public release of `appflare-pack`, which turns an app's repository into a release Appflare can install. It builds the app, checks its wrangler config against the catalog manifest, and writes a zip with a manifest listing every file's hash. It signs that manifest, verifies a release before it is published, and shows which parts of a wrangler config Appflare supports.
