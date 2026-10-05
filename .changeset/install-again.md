---
"@appflare/manager": minor
---

An install that did not finish can be installed again once its cause is fixed: **Install again** on the app's page, on its row under Needs attention on Home, and on the failed job's log opens the install form filled in from last time (Worker name, address and domain, Cloudflare Access, name, settings), and the automatic-update choice carries over. The Workers Paid, cost and requirements confirmations are asked again. Secret values and database connection strings are never stored, so the form asks for them again; generated secrets get new values. When the catalog has moved on, the form installs the current version and says what no longer applies. Installing again first uninstalls the failed install, deleting everything it left in the account and keeping nothing, and the new install waits for that removal before it creates anything, so nothing is created twice or left behind.
