---
"@appflare/manager": minor
---

Health checks no longer count Cloudflare Access's sign-in page as the app answering. When an Access application protects an app's address, Access redirects every request without a sign-in before it reaches the app, and Appflare used to record that as **Verified**. The check now stops at that answer, and the app's page shows **Behind Cloudflare Access**: Appflare can't check the app itself. Such an app is not listed on Home as not responding, and the scheduled check does not report it as failing. An update or settings change that gets the sign-in page at the new version's preview URL goes on without checking the new version and says so in its log. A custom or external domain where Access answers counts as live, as before, so the workers.dev URL still goes off and the app is not left reachable there without Access; the domain's check now says it is live behind Cloudflare Access. When Access answers Appflare's own preview during a self-update, the error says to let the preview URLs answer `/api/health` without a sign-in.

This version adds a column to the database, so **Roll back** in Appflare cannot return from it to an earlier version; roll back from the Cloudflare dashboard instead.
