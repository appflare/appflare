---
"@appflare/schema": patch
---

The sandbox protocol gains GitHub access tokens: `githubTokenSecretName` and its name schema (only `GITHUB_TOKEN_<id>` names, so a request can never point at another secret), an optional `tokenSecret` on repository build requests, the `githubFetch` request (an https URL on github.com or api.github.com, the token's secret name, and the few headers GitHub needs), and the `github-tokens` feature.
