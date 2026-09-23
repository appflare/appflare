---
"@appflare/schema": minor
---

The catalog manifest takes an optional `install.emailRouting: { catchAll?: boolean; rules?: string[] }` for apps that receive email through Cloudflare Email Routing. `rules` lists up to 10 addresses, each a lowercase local part such as `inbox` (routed as `inbox@<zone>`) or a full address in the zone the admin chooses; `catchAll: true` sends every other address of the zone to the app. One of the two is required. The JSON Schema carries the new field with its descriptions.
