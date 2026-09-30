---
"@appflare/manager": minor
---

The manager can now protect an installed app with Cloudflare Access. No form offers it yet, so nothing changes until an install asks for it. Each protected app gets its own Access application, named "Appflare: <app> (<Worker>)", with 24-hour sign-ins and no App Launcher tile. It lets in the "Appflare users" policy and the app's own health-check token. The application covers every Worker of the app by its script tag: its workers.dev address, every preview, its custom domains and routes. It is refused when another Access application already covers one of the app's addresses, for apps deployed by their own installer, and for now together with external domains: an install that asks for both is refused, and so is adding an external domain to a protected app. It is recorded with its audience tag and team domain, and as a resource of the install, and uninstalling the app removes it after the app is gone.

An install started with `access: true` makes the application before anything of the app exists in the account, covering the future workers.dev addresses, and switches it to the app's Workers right after the last upload, before any address, preview or domain is turned on. If that fails the install fails, and the app's Workers are taken off workers.dev with their previews first. The health check at the end then checks the app through Access with its token. Health checks now look up an app's token once per check instead of once per attempt, and once Access has let the token through, later attempts of the same check send it straight away instead of asking Access first.

Custom and wildcard domains need nothing: the Worker's own destination covers them.

Removing Appflare from the account keeps protected apps' Access applications and the "Appflare users" policy, so those apps keep asking for a sign-in. The review lists them under what stays, and the removal takes each app's health-check token out of its application and deletes it. Who can sign in is then managed in the Zero Trust dashboard.
