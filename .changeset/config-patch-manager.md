---
"@appflare/manager": patch
---

A sandbox build of an app whose catalog manifest patches its wrangler config (`install.configPatch`), from the catalog or from source, is refused before it starts when the sandbox Worker does not list the `config-patch` feature, with a message to update the sandbox Worker; an older one would build the config unpatched.
