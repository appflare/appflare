---
"@appflare/schema": minor
---

Catalog manifests can mark a secret `"optional": true` when the app works without it, and give a var `"type": "select"` with `"options"` (2 to 20 `{ value, label }` pairs with distinct values) when it takes one of a few fixed values. A select var's `default` must be one of its values, and for a var the app reads as JSON each option value must be JSON text (checked by `catalogVarProblems`). Optional secrets are refused on self-deploying entries, whose installer runs with every secret the manifest lists. The new fields are optional rather than defaulted, so manifests and artifacts written before them parse to the same shape. The JSON Schema states the new rules too. New helpers: `isOptionalSecret`, `catalogVarOptions`, `selectVarProblems`.
