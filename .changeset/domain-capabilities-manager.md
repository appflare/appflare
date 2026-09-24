---
"@appflare/manager": minor
---

Account capabilities now include Domains (whether Appflare's token can see an active zone in the account) and Email Routing (whether it can read Email Routing on that zone). They are checked with the others at token save, once a day and on "Re-check", with two more read calls, and shown in Settings. The catalog marks "Domain and DNS" and "Email Routing" as available or not available from them instead of unknown, and an app's zone and Email Routing requirements count as met when they were detected. Values stored before this change stay readable; the new rows say "Not checked yet" until the next check.
