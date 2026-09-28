---
"@appflare/manager": minor
---

Install links, and signing in no longer loses the page you asked for.

- Opening a page while signed out (an app's settings, a catalog page, a section of either) now brings you back to that page, section included, once you sign in with a password or a passkey, reset a forgotten password by emailed link or recovery code, or finish setting up a new Appflare. Only Appflare's own pages are accepted as the way back; anything else goes to Home.
- `/install/<slug>` opens an app's catalog page when one of your catalogs lists it (for an admin, the catalogs are fetched once more first, in case it was just published), or a plain page saying it is not in your catalogs, with a link to the catalog and, for admins, to Catalog settings, and a note when the official catalog is turned off.
- `/install/github/<owner>/<repo>` opens the catalog page with "Install from a repository" open and the repository filled in, for admins. Nothing is built until the admin confirms. Anything that is not a GitHub repository gets a plain page.
- Your account has a "Use this Appflare on appflare.dev" link under the Cloudflare connection, so Install buttons on appflare.dev open this Appflare. The address is passed in the link's fragment, which browsers never send to a server.
