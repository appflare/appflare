---
"@appflare/cf-api": minor
---

`probeAccessServiceTokens` reports whether the token can read Access service tokens ("Access: Service Tokens"): `readable` when the list answers (which proves Read, not Edit), `no-permission` when it is refused. `probeAccountSetup` now runs it with the workers.dev, Zero Trust and Analytics Engine probes and answers `accessServiceTokens` next to them.
