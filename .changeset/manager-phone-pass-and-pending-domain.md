---
"@appflare/manager": patch
---

Appflare reads better on a phone. A failed job now says what did not finish in a plain sentence, keeps Cloudflare's own words behind Details, and its buttons wrap under the text instead of running off the screen; the job log wraps its long lines. The Cloudflare connection card shows the account and how Appflare connects, with everything else (ids, the last problem, why Appflare holds each permission) behind Details, and its dialog, outcome messages and Home's reconnect row each say one short line. Setup's "Finish where you installed Appflare" step is shorter too.

On an Appflare connected with Cloudflare sign-in, refusals about custom domains, Email Routing, the external domains gateway, Hyperdrive and uninstalls no longer talk about a token: they say to reconnect Cloudflare. Appflare connected with an API token says what it said before.

Installed from the browser for a domain that did not answer yet, and opened at its workers.dev address instead, Appflare now moves to that domain by itself once it answers, with the same move as Settings, Domains. Before it moves, an Appflare installed from the browser checks the domain gives its own handoff proof, not just any Appflare's health report. It tries by itself once: if that move fails, Settings, Domains says so in one line with Try again and Stay at workers.dev, and the waiting row offers Stay at workers.dev too. A domain removed from Appflare's Worker meanwhile stops being waited for. Owner setup at workers.dev asks for a password only, and Your passkeys offers none there until the move. After the move, the sign-in page at the domain says Appflare moved there and offers to add a passkey.
