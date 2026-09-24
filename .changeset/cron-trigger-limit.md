---
"@appflare/manager": patch
"@appflare/cf-api": patch
---

Installs and updates now respect the account-wide cron trigger limit. Workers Free allows 5 cron triggers per account, across every Worker, and Appflare itself uses one. Before it creates anything, an install of an app with cron triggers (and an update whose new version sets more of them than the Worker has) counts the triggers the account's other Workers use, and stops with a message that names the count, the Workers using them, and the ways out: remove a trigger elsewhere, upgrade to Workers Paid, or, if the account already is on Workers Paid, record that in Settings. The count lists the account's Workers once and reads the schedule of each Worker that exports a `scheduled` handler, in a job unit of its own, so it costs the job one subrequest; an account with more than 20 such Workers is not counted. The check is skipped when the account is on Workers Paid: Settings records it, the admin confirms it for this install or update, or the app itself needs Workers Paid.

When Cloudflare refuses a schedule anyway (error 10072, "This account has reached the Workers Free limit of 5 cron triggers per account"), the "set cron triggers" step now says what happened and what to do instead of showing the raw API error. An install still fails at that step. An update or rollback, whose version already serves traffic, now sets the queue consumers first and treats the refusal as a warning: the Worker keeps the cron triggers it had, the log names the ones it did not get, and the job goes on to its health check and finishes.

Settings has a new "Workers plan" card. Cloudflare's API offers no plan signal the manager can read, so an admin states whether the account is on Workers Free (the default) or Workers Paid; the choice is stored in the `settings` table as `account_plan`. When it says Workers Paid, the install form no longer asks to confirm Workers Paid for apps that need it, and installs and updates skip the cron trigger count. When it says Workers Free, the confirmations are asked per install as before, and ticking one also offers "Remember this for the account", which records Workers Paid.

The catalog page, the install form, and the update dialog show "Uses N cron triggers (the free plan allows 5 per account)" for an app that declares any. While the account is recorded as on Workers Free, the form and the dialog offer an optional "This account is on Workers Paid" confirmation with it.

`WorkerScript` in `@appflare/cf-api` now types the `handlers` field that `GET /workers/scripts` returns.
