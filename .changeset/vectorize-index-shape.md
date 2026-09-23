---
"@appflare/schema": minor
"@appflare/pack": minor
"@appflare/manager": minor
---

Apps that bind a Vectorize index can be installed. A wrangler config cannot
say how to create the index, so the catalog manifest states it in
`resources.vectorize`, keyed by binding name:
`{ "dimensions": 1-1536, "metric": "cosine" | "euclidean" | "dot-product" }`.
The packer records both on the artifact's Vectorize binding and refuses a
Vectorize binding the catalog manifest does not declare (and a declaration for
a binding the wrangler config does not have), naming the field to add;
`verify` checks the two agree. The artifact schema types the Vectorize binding,
and the manager creates the index from it at install, binds it by name, and
deletes it on uninstall when ticked. An update whose version changes the
dimensions or metric of an index the install already has is refused before
anything changes: an index cannot be reshaped in place, so that version needs a
fresh install.
