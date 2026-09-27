---
"@appflare/schema": minor
---

A catalog manifest can set `install.wildcardHostname: true` for an app that needs every name under one hostname (`*.<base>`), such as a tunnel that gives each session an address of its own, with a one-sentence `install.wildcardReason` shown where the admin assigns the hostname. The reason is required with the flag and refused without it, and neither is allowed on a self-deploying entry; the JSON Schema states the same rules. `needsWildcardHostname` reads the flag. A new install placeholder, `{{wildcardHostname}}`, fills in the hostname of the install's wildcard domain (empty while it has none; kept as written where the value is not known).
