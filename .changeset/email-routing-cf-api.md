---
"@appflare/cf-api": minor
---

Add Email Routing calls under `emailRouting`: `getSettings`, `enableRouting` and `disableRouting` (`POST` and `DELETE /zones/{id}/email/routing/dns`, which turn routing on with its MX, SPF and DKIM records and off again), `getDnsRecords`, `listRules` (every page), `createRule`, `deleteRule`, `getCatchAll`, `updateCatchAll`, and the account's `listDestinationAddresses`. Every answer is checked against the fields read, and an unexpected shape throws `EmailRoutingShapeError`.
