---
"@appflare/manager": minor
---

Settings has a new "Account capabilities" section: whether R2 is enabled, whether Containers are available, and the account's Workers plan, each marked "Detected" or "Set by you". Appflare reads them with its Cloudflare token when the token is saved or rotated, once a day from the cron, and when an admin chooses "Re-check", with one read call each. The Workers plan is read from the account's subscriptions when the token has the new optional "Billing: Read" permission, which the token link now includes and which Appflare uses only for the plan names. The detected plan now comes first everywhere the plan matters (Workers Paid confirmations and the count of cron triggers against the free plan's 5); the plan an admin sets applies when it cannot be detected. The catalog page shows what was detected next to an app's Workers Paid, R2 and Containers requirements.
