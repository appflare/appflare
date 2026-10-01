---
"@appflare/schema": minor
---

A catalog manifest can now say how its app goes with Cloudflare Access, in an optional `access` block. `"mode": "required"` means the app is installed only behind Access and its protection cannot be turned off; `"mode": "recommended"` starts the install form's protection switch on; without a mode protection is offered, switched off. `"bypass"` lists up to 10 paths that stay public while the app is protected, such as `"/s/*"` or `"/api/webhook"`: each starts with `/`, may end in `/*`, and has no other wildcard, query or fragment; `/` and `/*` are refused, and so is a path listed twice. The block is refused on the self-deploying tier, and the JSON Schema says so too. `accessOfferOf` and `accessBypassPaths` read it.

Three new placeholders, for a var's value only: `{{accessTeamDomain}}` (`<team>.cloudflareaccess.com`), `{{accessAud}}` (the audience tag of the app's Access application) and `{{accessCertsUrl}}` (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`). All three are empty while the app is not protected. `postInstall` text does not take them; its placeholders are exported as `POST_INSTALL_PLACEHOLDERS`, and `PlaceholderValues` takes the protection as `access`.

`requires` takes a new value, `"access"`, and an entry must list it when its `access.mode` is `"required"` or a var (a catalog default, or a value in the app's wrangler config) uses an Access placeholder. A manager from before this release strips the `access` block and leaves the placeholders as written, but its index schema does not know the `"access"` requirement, so it leaves such an entry out of its catalog instead of installing it unprotected.

Rollout: release this schema first, move the catalog's checks and its index generator onto it, and only then let entries use `access` or the new placeholders.
