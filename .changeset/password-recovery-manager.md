---
"@appflare/manager": minor
---

A forgotten password can be reset from the sign-in page. "Forgot your password?" offers a one-time recovery code, which the owner can issue for any other user and an admin for a member from the user's menu in Settings > Users and access ("Reset password"), and which whoever manages the Cloudflare account can get with `npx create-appflare recover` for any admin, the owner included. The owner can also turn on password reset emails with a sender address on a domain set up for Cloudflare Email Sending; Appflare then adds an email binding to its own Worker and emails reset links. Codes and links work once, for 30 minutes, are stored only as fingerprints, are rate limited, and sign the user out everywhere. Reset link tokens are stored hashed, and the scheduled check deletes a recovery code secret once it is used or expired. Settings shows the last reset done without the old password.
