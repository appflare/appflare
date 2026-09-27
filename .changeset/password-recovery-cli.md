---
"@appflare/cli": minor
---

`create-appflare recover` gets a locked-out owner or admin back in. It uses your Cloudflare login, saves a fingerprint of a new one-time code on the manager Worker as the secret `RECOVERY_CODE_HASH`, and prints the code, which works once, for 30 minutes, under "Forgot your password?" on the sign-in page. `--email` makes the code work only for one admin. It sends no usage data.
