---
title: Custom domains
description: Serve an installed app on a hostname in one of your own domains.
---

Every app gets a `workers.dev` URL. You can also serve it on a hostname in a domain
you have on Cloudflare, such as `notes.example.com`. Cloudflare creates the DNS record
and the certificate; the `workers.dev` URL keeps working.

For a hostname whose DNS is managed somewhere else, see
[Domains held outside this account](#domains-held-outside-this-account).

## What you need

- A domain (a zone) on this Cloudflare account, with the status **Active**.
- A Cloudflare token for Appflare with three more permissions: **Zone: Read**,
  **DNS: Edit**, and **Workers Routes: Edit**, for the domains you want to use. The
  token link in setup includes them. Appflare works without them; only custom
  domains (and [wildcard domains](#wildcard-domains)) need them.

If the token lacks them, the **Add a domain** dialog says which ones. Open **API
Tokens** in the Cloudflare dashboard, edit the Appflare token, add the permissions
for your domains, and save. An edited token keeps its value, so nothing changes in
Appflare. You can also create a new token and replace the old one under **Settings**,
**Account and capabilities**, with **Rotate token**.

## Add a domain

On the app's **Domains and email** tab, admins find **Custom domains** and select
**Add a domain**. The install form offers the same under **Address**, and the install
adds the domain once the app runs.

1. Choose the domain. Only active domains are listed.
2. Enter the hostname: the domain itself or a name under it. Wildcards are not
   allowed; a custom domain matches one exact hostname.
3. Select **Add domain**.

If the hostname already has DNS records (for example an `A` or `CNAME` record that
points at another server), Appflare shows them and adds nothing. Tick **Replace the
existing DNS records** to let Cloudflare replace them with the app's record; whatever
they pointed to then stops receiving traffic for that hostname.

A hostname that already serves another Worker is refused. Remove it from that Worker
first.

The app's page lists the new hostname next to the `workers.dev` URL. It can take a
few minutes before the DNS record and certificate are live; **Check now** next to the
domain sends one request to it.

## Remove a domain

Select **Remove** next to the domain. The app stops answering on that hostname.
Uninstalling an app removes all of its custom domains first.

## Wildcard domains

Some apps need every name under one hostname rather than one exact hostname. A
tunnel, for example, gives each session an address of its own, such as
`https://a1b2c3.tunnels.example.com`. For these apps the section is called
**Wildcard domain**, and the install form's **Address** offers **Wildcard domain**
instead of a custom domain. The dialog says why the app needs it.

1. Choose the domain and enter the hostname the app gets, such as `tunnels` for
   `tunnels.example.com`. The app answers on that hostname and on every name under it
   (`*.tunnels.example.com`).
2. Select **Add wildcard domain**.

A custom domain matches one exact hostname and cannot be a wildcard, so Appflare
serves the name with Workers routes instead. In the domain's zone it adds:

- two proxied DNS records, `tunnels.example.com` and `*.tunnels.example.com`, each an
  `AAAA` record to `100::` with the comment `Appflare: serves the Worker <name>`;
- two Workers routes to the app's Worker, `tunnels.example.com/*` and
  `*.tunnels.example.com/*`.

The app page shows the domain as `*.tunnels.example.com` and lists the records and
routes with the app's resources. Updates and settings changes keep them. **Check
now** and the health check send their request to `tunnels.example.com`. Once the app
answers there, the `workers.dev` URL is turned off, as with any custom domain.
**Remove** deletes the routes, then the records; uninstalling the app does the same
before it deletes the Worker. An app has at most one wildcard domain.

An app whose settings use `{{wildcardHostname}}` (for example a tunnel's
`TUNNEL_DOMAIN`) gets the hostname in them: empty until a wildcard domain is
assigned, then `tunnels.example.com`. Adding or removing the wildcard domain on the
app page starts a settings change that deploys the app's settings again with the new
value, and opens its log. If another job of the app is running, Appflare says so
instead; save the app's settings once it is done.

Appflare adds nothing and says why when a name already has `A`, `AAAA` or `CNAME`
records of its own, when a route for either pattern sends requests to another
Worker, or when the hostname is another Worker's custom domain. It also refuses a
hostname with names under it that already go through Cloudflare's proxy, such as
`api.tunnels.example.com`, because the app would take them over; the message names
them. Names that are another app's custom domain, or that a more specific Workers
route already serves, stay as they are and do not count. Delete those in the Cloudflare dashboard (or turn off their proxy), or choose
another name. If you agreed to serve a whole domain, its existing names are part of
that agreement.

If Cloudflare stops Appflare part way through, for example because the token lacks
**Workers Routes: Edit**, Appflare removes the records and routes it had already
added and says so, so you can fix the reason and add the domain again. When the reason
may pass by itself, such as a short Cloudflare outage, the install tries again on its own. A route to the
app's Worker that you made yourself is used as it is and stays when the wildcard
domain is removed.

When the install form asked for a wildcard domain that could not be set up, the
install still finishes, and Appflare deploys the app's settings again so that
`{{wildcardHostname}}` does not name a hostname the app does not have.

### Certificates

Cloudflare's free certificate for a domain covers the domain and the names one level
under it: `example.com` and `*.example.com`. With `tunnels.example.com`, the hostname
itself works, but names under it such as `a1b2c3.tunnels.example.com` are two levels
down and have no valid certificate until the domain has one that covers
`*.tunnels.example.com`. Turn on **Total TLS** (part of Advanced Certificate Manager,
a paid add-on) for the domain, or upload a certificate that covers it.

A domain kept for the app, used at its root (`example.com`, leaving the name empty),
avoids this, since the free certificate covers `*.example.com`. Every name in the domain then reaches the app,
including names that serve something else through Cloudflare's proxy today, so
Appflare asks you to confirm first. Use a domain you keep for the app.

### Domains held outside this account

Wildcard domains need a domain on this Cloudflare account. An
[external domain](/guides/external-domains/) cannot be a wildcard: Cloudflare offers
wildcard custom hostnames on the Enterprise plan only, so Appflare refuses an external
domain for these apps.

## Turn off the workers.dev URL

Once a custom domain or an [external domain](/guides/external-domains/) serves the
app, admins can turn off **Serve on workers.dev** on the app's **Domains and email**
tab. Appflare first sends one request to each of the app's domains and turns the
`workers.dev` URL off only when one of them answers as the app. Updates keep
the choice, and their checks still work because Cloudflare keeps the Worker's
preview URLs. While it is off, health checks, **Open app** and the `{{workerUrl}}`
value an app's settings may use all point at the domain that answered (or, once that
domain is removed, the first remaining one), and the app's last domain cannot be
removed. A setting that uses `{{workerUrl}}` changes with the app's next update or
settings change. Turn the switch back on at any time.

## Domains held outside this account

A custom domain has to be in a domain on this Cloudflare account. To serve an app on
a hostname whose DNS is managed elsewhere (a customer's domain, a domain at another
registrar, or one in another Cloudflare account), use an
[external domain](/guides/external-domains/). It goes through Cloudflare for SaaS on
one domain of this account, the gateway domain:

1. Turn on Cloudflare for SaaS for the gateway domain in the Cloudflare dashboard
   (**SSL/TLS**, **Custom Hostnames**, **Enable**). Cloudflare asks for a payment
   method; the first 100 external domains cost nothing, then $0.10 a month each.
2. Give the Appflare token **SSL and Certificates: Edit** on that domain, besides the
   three permissions above, with **Zone: Read** on all zones of the account.
3. In **Settings**, **Domains**, choose the domain and select **Set up gateway**.
   Appflare adds the Worker `appflare-gateway`, its route and a DNS record; the
   domain's own sites keep working.
4. On the app's **Domains and email** tab, select **Add an external domain**. The
   domain's owner adds the CNAME (or TXT records) shown there, and the app answers on
   it a minute or two later.

[External domains](/guides/external-domains/) covers each step, what visitors see
while a domain is pending, removal, and turning the gateway off.
