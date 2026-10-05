# @appflare/schema

## 0.3.0

### Minor Changes

- c900272: Catalog secrets and vars take an optional `link`, `{ "label", "url" }`, shown beside the field in the install, update and settings forms, such as `{ "label": "Get a key", "url": "https://openrouter.ai/settings/keys" }`. `label` is one line of at most 40 characters without leading or trailing spaces; `url` is an https:// URL of at most 500 characters without spaces, user name or password (`catalogFieldLinkSchema`, `CatalogFieldLink`). Help text stays plain text.
  
  A catalog manifest takes an optional top-level `openPath`, such as `"/dashboard"`: where the manager's Open buttons go within the app. It is a path only, at most 128 characters: it starts with `/`, has no query, fragment, empty, `.` or `..` segment, holds letters, digits and `- . _ ~ @ : + = ,`, and may end in `/`; `/` alone is refused (`openPathSchema`, `openPathProblem`, `OPEN_PATH_PATTERN`). `appOpenUrl(address, openPath)` puts it after an app's address. Health checks and `{{appUrl}}` stay the root.
  
  A catalog revision may add, change or remove both: `openPath` joins `REVISABLE_CATALOG_FIELDS`, and a `link` is part of `secrets` and `vars`, which a revision could already change. Managers from before this release strip both keys, as they strip any key they do not know, so an entry may use them without a new requirement: such a manager shows the field without its link and opens the app at its root. The packer and catalog checks refuse both keys until they run this release.

### Patch Changes

- afbe792: The descriptions of `bump` and `bump.autoMerge` follow the catalog's new rule. The catalog checks that each upstream release builds, matches its hashes and installs, and users decide whether to update, so the catalog's bump bot reads `autoMerge` from the manifest file itself: left out or `true`, a bump of an artifact tier entry that does not set `source.version` merges itself once the required checks pass; `"bump": { "autoMerge": false }` opts out. Sandbox and self-deploying entries are never merged by the bot and still may not set `true`. Parsing is unchanged: the parsed value still defaults to `false`, only so that released catalog manifests keep their bytes, and it does not mean the entry opts out.
  
  `codemod-manifest-v1` now keeps an explicit `"bump": { "autoMerge": false }` instead of dropping it as the default, since dropping it would now let the entry's bumps merge themselves.
- 482eb0b: Correct the description of `definesWorkflow`: uploading a Worker does not create its Workflows; whoever deploys it creates them with a separate call.

## 0.2.0

### Minor Changes

- b2e7bfd: A catalog manifest can now say how its app goes with Cloudflare Access, in an optional `access` block. `"mode": "required"` means the app is installed only behind Access and its protection cannot be turned off; `"mode": "recommended"` starts the install form's protection switch on; without a mode protection is offered, switched off. `"bypass"` lists up to 10 paths that stay public while the app is protected, such as `"/s/*"` or `"/api/webhook"`: each starts with `/`, may end in `/*`, and has no other wildcard, query or fragment; `/` and `/*` are refused, and so is a path listed twice. The block is refused on the self-deploying tier, and the JSON Schema says so too. `accessOfferOf` and `accessBypassPaths` read it.
  
  Four new placeholders, for a var's value only: `{{accessTeamDomain}}` (`<team>.cloudflareaccess.com`), `{{accessTeamName}}` (the `<team>` alone, for an app that builds `https://<team>.cloudflareaccess.com` itself), `{{accessAud}}` (the audience tag of the app's Access application) and `{{accessCertsUrl}}` (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`). All four are empty while the app is not protected. `postInstall` text does not take them; its placeholders are exported as `POST_INSTALL_PLACEHOLDERS`, and `PlaceholderValues` takes the protection as `access` (its `teamName` is worked out from `teamDomain` when absent, see `accessTeamNameOf`).
  
  `requires` takes a new value, `"access"`, and an entry must list it when its `access.mode` is `"required"` or a var (a catalog default, or a value in the app's wrangler config) uses an Access placeholder. Without `"mode": "required"` it holds only while the app is protected (`accessNeededOnlyIfProtected`): the app still installs unprotected anywhere. A manager from before this release strips the `access` block and leaves the placeholders as written, but its index schema does not know the `"access"` requirement, so it leaves such an entry out of its catalog instead of installing it unprotected.
  
  Index rows take an optional `accessOffer` (`"required"`, `"recommended"` or `"offered"`, from the entry's revised catalog manifest; see `indexAccessOffer`), a plain string so a later value never drops a row. `indexAccessNeededOnlyIfProtected` reads it: a row without it counts its `"access"` as always needed. Managers that predate it strip it, since index rows are parsed as plain objects.
  
  A catalog revision may now add, change or remove the `access` block, and add `"access"` to `requires` (nothing else about `requires`; `requirementsRevisionProblem` says why a change is refused), so a released app can take up Access without a new pin. The revised manifest is parsed like any other, so its placeholders and `access.mode` still need the requirement.
  
  Rollout: release this schema first, move the catalog's checks and its index generator onto it, and only then let entries use `access` or the new placeholders.
- 1fa72de: An app of several Workers may run a Workflow that another of its Workers defines. A Workflow binding's `script_name` recorded as `{{workerName:<name>}}` now counts as a binding to that Worker (`bindingEntryRefs`), so the Worker that defines the Workflow is deployed first. The artifact checks require that Worker to define a Workflow of the same name and class, and refuse two Workers that define one Workflow. New helpers: `definesWorkflow(binding)` and `upstreamWorkflowName(binding)`.

### Patch Changes

- b2e7bfd: The description of `install.health.mode` now says that Cloudflare Access's own sign-in redirect never counts as the app serving, under either mode, and that `"any-response"` is for apps whose health path asks for a sign-in, their own or one they check from Cloudflare Access.

## 0.1.0

### Minor Changes

- 346d608: The first public release of the schemas Appflare's manager, installer and catalog share. It defines version 1 of the catalog manifest (`appflare.jsonc`), the release artifact and the catalog index, as Zod schemas and as a JSON Schema for editors. It also carries the fixed list of catalog categories and the public keys that verify signed releases.
