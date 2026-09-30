---
"@appflare/manager": minor
---

Groundwork for protecting installed apps with Cloudflare Access; nothing changes until an app is protected. Appflare can now keep one "Appflare users" Access policy that lets in every Appflare user who is not banned (members too), and give each protected app its own service token, used only by Appflare's health checks of that app and never sent anywhere else. A token's secret is kept only encrypted, with a key derived from the manager's own auth secret, in a new `install_access` table. Adding, deleting or changing the role of a user keeps the users policy up to date; when that fails, the users page says so and the scheduled check tries again. The scheduled check also renews each app's token when it has less than 30 days left, and uninstalling a protected app removes its Access application and its token.

Health checks, update checks and domain checks of a protected app send its token only to that app's own addresses (its workers.dev name and version previews, and its custom and wildcard domains in the account's own zones), never to an external domain or another app, and only in a second request after the first one, sent without it, got Cloudflare Access's sign-in for that address, so a protected app can be verified instead of showing the Access sign-in. Uninstalling a protected app removes its Access protection after the app itself is gone; if that fails, the uninstall still finishes and the log says what to delete by hand.

The Cloudflare token form now also asks for the optional "Access: Service Tokens: Edit" permission, listed with the other Access permissions under Cloudflare Access, and "What this account can run" names it when the token cannot read service tokens.
