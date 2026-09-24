---
"@appflare/cf-api": minor
---

Add domain capability probes: `probeDomainCapabilities` lists one active zone of the account (`GET /zones?account.id=…&status=active&per_page=1`) and, when there is one, reads its Email Routing settings (`GET /zones/{zone_id}/email/routing`), two read calls at most. The zone answer is `available`, `none` (no active zone in the account, which is also what a token without "Zone: Read" sees), or unknown with the reason; Email Routing is `available`, `no-zone`, or unknown (a 401 or 403 means the token lacks "Zone Settings: Read"). `probeEmailRouting` reads one given zone. `probeAccountCapabilities` still runs only the three account-level probes, so `sandbox enable` makes no extra calls. New client call: `zones.listAccountZonesPage`.
