---
title: Custom domains
description: Serve an installed app on a hostname in one of your own domains.
---

Every app gets a `workers.dev` URL. You can also serve it on a hostname in a domain
you have on Cloudflare, such as `notes.example.com`. Cloudflare creates the DNS record
and the certificate; the `workers.dev` URL keeps working.

## What you need

- A domain (a zone) on this Cloudflare account, with the status **Active**.
- A Cloudflare token for Appflare with three more permissions: **Zone: Read**,
  **DNS: Edit**, and **Workers Routes: Edit**, for the domains you want to use. The
  token link in setup includes them. Appflare works without them; only custom
  domains need them.

If the token lacks them, the **Add a domain** dialog says which ones. Open **API
Tokens** in the Cloudflare dashboard, edit the Appflare token, add the permissions
for your domains, and save. An edited token keeps its value, so nothing changes in
Appflare. You can also create a new token and replace the old one under **Settings**
with **Rotate token**.

## Add a domain

On the app's page, admins find **Custom domains** and select **Add a domain**:

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
