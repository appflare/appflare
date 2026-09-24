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
  domains need them.

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
