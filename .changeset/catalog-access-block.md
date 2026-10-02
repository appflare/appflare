---
"@appflare/schema": minor
---

A catalog manifest can now say how its app goes with Cloudflare Access, in an optional `access` block. `"mode": "required"` means the app is installed only behind Access and its protection cannot be turned off; `"mode": "recommended"` starts the install form's protection switch on; without a mode protection is offered, switched off. `"bypass"` lists up to 10 paths that stay public while the app is protected, such as `"/s/*"` or `"/api/webhook"`: each starts with `/`, may end in `/*`, and has no other wildcard, query or fragment; `/` and `/*` are refused, and so is a path listed twice. The block is refused on the self-deploying tier, and the JSON Schema says so too. `accessOfferOf` and `accessBypassPaths` read it.

Four new placeholders, for a var's value only: `{{accessTeamDomain}}` (`<team>.cloudflareaccess.com`), `{{accessTeamName}}` (the `<team>` alone, for an app that builds `https://<team>.cloudflareaccess.com` itself), `{{accessAud}}` (the audience tag of the app's Access application) and `{{accessCertsUrl}}` (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`). All four are empty while the app is not protected. `postInstall` text does not take them; its placeholders are exported as `POST_INSTALL_PLACEHOLDERS`, and `PlaceholderValues` takes the protection as `access` (its `teamName` is worked out from `teamDomain` when absent, see `accessTeamNameOf`).

`requires` takes a new value, `"access"`, and an entry must list it when its `access.mode` is `"required"` or a var (a catalog default, or a value in the app's wrangler config) uses an Access placeholder. Without `"mode": "required"` it holds only while the app is protected (`accessNeededOnlyIfProtected`): the app still installs unprotected anywhere. A manager from before this release strips the `access` block and leaves the placeholders as written, but its index schema does not know the `"access"` requirement, so it leaves such an entry out of its catalog instead of installing it unprotected.

Index rows take an optional `accessOffer` (`"required"`, `"recommended"` or `"offered"`, from the entry's revised catalog manifest; see `indexAccessOffer`), a plain string so a later value never drops a row. `indexAccessNeededOnlyIfProtected` reads it: a row without it counts its `"access"` as always needed. Managers that predate it strip it, since index rows are parsed as plain objects.

A catalog revision may now add, change or remove the `access` block, and add `"access"` to `requires` (nothing else about `requires`; `requirementsRevisionProblem` says why a change is refused), so a released app can take up Access without a new pin. The revised manifest is parsed like any other, so its placeholders and `access.mode` still need the requirement.

Rollout: release this schema first, move the catalog's checks and its index generator onto it, and only then let entries use `access` or the new placeholders.
