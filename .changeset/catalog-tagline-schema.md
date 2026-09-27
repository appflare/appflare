---
"@appflare/schema": minor
---

A catalog manifest can set `tagline`: what the app does as one plain sentence of at most 80 characters, without a trailing period, shown under the app's name on catalog tiles. It is optional, revisable like `summary`, and checked by `taglineSchema` (also in the JSON Schema). Index rows gain two optional fields: `tagline`, copied from the manifest, and `addedAt`, an ISO 8601 time for when the entry joined the catalog, which managers use for "New this week". Indexes and manifests without them still parse.
