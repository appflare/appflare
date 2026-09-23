---
"@appflare/manager": minor
"@appflare/cf-api": minor
---

Protect the manager with Cloudflare Access. An admin turns it on under Settings → Cloudflare Access: Appflare checks that the API token may manage Access and that the account has a Zero Trust organization (it links to the dashboard to create one when there is none; the Free plan covers up to 50 users), lists the login methods, and asks the admin to confirm they can sign in through Access with their own email. It then creates a self-hosted Access application for the manager's address that allows only the admins' emails, plus one that keeps `/api/health` open for health checks. From then on the manager checks the Access token on every request, refuses anything without a valid one with a page that explains why and how to get back in, and never logs the token. Adding an admin updates the allow list, and "Re-sync admins" rewrites it after any other change. Turning it off deletes both applications.

The token template now also asks for "Access: Apps and Policies: Edit" and "Access: Organizations, Identity Providers, and Groups: Read"; only this setting uses them, and the setup and rotate-token steps say so. Existing tokens keep working; rotate to a token with those two permissions before turning Access on.

The API client gains typed calls for the Zero Trust organization, its login methods, self-hosted Access applications and their policies, and a fetch of a team's public signing keys.

In-progress install and job status badges no longer log a warning in the browser console.
