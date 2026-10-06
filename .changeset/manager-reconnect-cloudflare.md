---
"@appflare/manager": minor
---

Reconnect Cloudflare in Settings › Your account. When Cloudflare stops accepting Appflare's connection, an administrator chooses Reconnect Cloudflare there, or from the row on Home. There are two ways. Sign in with Cloudflare gives Appflare every permission it needs at once. Cloudflare asks you to approve, then appflare.dev asks you to confirm your Appflare's address before it brings you back. Use an API token is the token you create in the Cloudflare dashboard and paste, as before. Your apps keep running the whole time.

While the connection works, the same choice is under Change how Appflare connects, so you can move from an API token to Cloudflare sign-in or back on purpose. Appflare checks that the new connection is for the same account and the same Appflare before it replaces anything, and nothing changes when a sign-in is cancelled or fails. Moving to Cloudflare sign-in removes the old API token from Appflare's Worker. Moving to a token withdraws the sign-in at Cloudflare.

The connection card now says how Appflare is connected ("Connected with Cloudflare sign-in" or "Connected with an API token"), since when, and whether it works. The permissions are under Details.
