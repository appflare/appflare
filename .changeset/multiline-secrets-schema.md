---
"@appflare/schema": minor
---

Catalog secrets can be multi-line: `secrets[].multiline: true` marks a value of several lines, such as a PEM private key, which the forms ask for in a text area that keeps its line breaks. It cannot be combined with `generate` or `derive` (`multilineSecretProblems`, also stated in the JSON Schema); `isMultilineSecret` tells whether a secret is one. `artifactFormatFor` gives format 5 to an artifact whose catalog manifest has a multi-line secret, so a manager too old to know the field refuses it instead of asking for the value on one line. The JSON Schema is regenerated.
