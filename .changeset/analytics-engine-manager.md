---
"@appflare/manager": minor
---

Appflare now checks whether Analytics Engine is turned on for the account, with the other account checks (at token save, on Re-check and once a day). The account checklist gains an optional "Analytics Engine" row with a link to its dashboard page and how many catalog apps write to it. Apps that need Analytics Engine show it as a requirement and a primitive with what the check found, and while it is off their install is refused with the fix: "Turn on Analytics Engine once in the dashboard, then Re-check." Cloudflare would otherwise refuse the deploy.
