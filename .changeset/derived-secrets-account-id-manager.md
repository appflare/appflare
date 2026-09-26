---
"@appflare/manager": minor
---

Apps can take the account id and a hashed password without the admin typing either.

- `{{accountId}}` in a var's catalog default, in the wrangler config's vars, or in a value the admin entered becomes the account's id on every install, update and settings change, for self-deploying installers' settings too. The install form shows it as written and says it is filled in; the app page shows the filled-in id in post-install notes and in its list of vars.
- A secret the catalog derives from another (`derive: { from, method: "bcrypt" }`) gets no field: the form asks for the source only and says which secrets follow it. Starting an install, an update that asks for the source, or a settings change that gives the source a new value computes the bcrypt hash (cost 10, bcryptjs, the library Counterscale checks it with) on the server and sets it with the source; a derived value sent in a request is refused, never used. An update whose version adds a derived secret asks for its source again and sets both, and a failed update puts the source's serving value back. Neither value is logged or stored outside the Workflow's params.
- A sandbox build of an entry that lists several build commands no longer repeats them in the request (the packer runs the list from the manifest), and a self-deploying installer run carries the list.

Adds the `bcryptjs` dependency.
