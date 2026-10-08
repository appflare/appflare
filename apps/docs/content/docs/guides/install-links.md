---
title: Install links
description: Links that open an app or a GitHub repository in your Appflare, ready to install, and how Appflare keeps them across sign-in.
---

An install link opens a page of your own Appflare with an app ready to install. Other
sites use them for their Install buttons, and a project's README can carry one as a
badge. An install link never installs or builds anything by itself: an admin still
reviews the app and confirms.

## Link to an app in the catalog

```
https://<your-appflare>/install/<slug>
```

`<slug>` is the app's short name in the catalog, for example `cut`. The link opens the
app's page in **Catalog**, where an admin selects **Install**. Members see the same
page without the install action.

If none of the catalogs your Appflare uses lists the app, you see **This app is not in
your catalogs** with a link to the catalog (and, for admins, to Catalog settings).
When an admin opens the link, Appflare fetches the catalogs once more before it says
so, so an app published a moment ago is found.
If the official catalog is turned off, the page says so; an admin can turn it back on
in [Catalog settings](/guides/custom-catalogs/).

To name an app in a catalog you added, put the catalog's ID in front of the slug:
`/install/acme:cut`.

## Link to a GitHub repository

```
https://<your-appflare>/install/github/<owner>/<repo>
```

The link opens **Catalog** with **Install from a repository** open and the
repository filled in. Choose a branch, tag or commit and a build command if you need
to, confirm the cost, then select **Build for review**. Nothing is built until you
do. See [Install from a repository](/guides/install-from-a-repository/) for what
happens next.

Only admins on Workers Paid can build from a repository. Members get the catalog
page, and on the free plan the page says what is missing.

Anything in the link that is not a GitHub owner and repository name is refused with a
plain page, and nothing opens.

## Signing in on the way

If you are signed out when you open an install link, or any other link to a page of
your Appflare such as an app's settings, Appflare asks you to sign in first and then
opens the page you asked for, section included. The same happens when you sign in with
a passkey, reset a forgotten password (by emailed link or recovery code), or finish
setting up a new Appflare.

Appflare only returns you to its own pages. A link that tries to send you anywhere
else after signing in takes you to Home instead.

## Use your Appflare on appflare.dev

Install buttons on appflare.dev need to know where your Appflare is. In **Settings >
Your account > Cloudflare connection**, select **Use this Appflare on
appflare.dev**. The site remembers your Appflare's address in your browser only; the
address is passed in the part of the link that browsers never send to a server.

## No Appflare yet

An Install button on appflare.dev asks whether you have Appflare. **Get Appflare**
offers [the install from your browser](/start/browser-install/#install-an-app-right-after),
which takes the app along: `appflare.dev/deploy/?app=<slug>`. When your new Appflare is
ready, setup opens with the app's install link waiting behind it, so **Finish** opens
the app's page. The deploy page also remembers your new Appflare in this browser, so
later Install buttons go straight to it.

A repository link does not travel this way: a new Appflare needs Workers Paid and
sandbox builds turned on before it can build one. Installed another way, open
**Use this Appflare on appflare.dev** once Appflare is ready: the browser keeps the
app you chose for 7 days, and appflare.dev offers to continue installing it.
