---
"@appflare/manager": patch
---

A sandbox build of an app whose catalog manifest carries its wrangler config inline (`install.wranglerConfigInline`) is refused before it starts when the sandbox Worker does not list the `wrangler-config-inline` feature, with a message to update it; an older one would find no config to build from. The review of a build from a repository names every wrangler config section the packer cannot install, as the schema labels them.
