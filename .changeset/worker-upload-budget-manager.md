---
"@appflare/manager": minor
---

Installs, updates, settings changes, self-updates, sandbox Worker releases and repository builds no longer refuse a Worker of more than 21 modules. Cloudflare has no module count limit, and the upload already reads adjacent modules with one Range request per 8 MiB, so a Worker of hundreds of modules costs a few subrequests. They refuse a Worker whose modules add up to more than 32 MiB instead, which one upload would have to hold in memory at once, or one whose modules would take more Range requests than the free plan's subrequests allow, before anything changes in the account.
