---
title: Apps that receive email
description: How Appflare sets up Cloudflare Email Routing for an app, which permissions it needs, and what uninstalling undoes.
---

Some apps receive email: an inbox, a mail-to-chat bridge, a newsletter archive. They
run an `email` handler on their Worker, and Cloudflare Email Routing delivers mail to
it. When such an app's catalog entry says which addresses it wants, Appflare sets up
Email Routing for you during the install.

## What you need

- A domain (a zone) on this Cloudflare account, with the status **Active**, that uses
  Cloudflare as its DNS provider. Email Routing does not work on zones whose DNS is
  hosted elsewhere.
- A Cloudflare token for Appflare with these permissions on that zone and account:

| Permission | Access | Used for |
| --- | --- | --- |
| Zone | Read | Listing your domains in the install form. |
| DNS | Edit | Reading the domain's MX records before turning Email Routing on, so Appflare can tell whether its mail already goes to another provider. |
| Zone Settings | Edit | Reading whether Email Routing is on, and turning it on or off. Cloudflare's API files these calls under Zone Settings. |
| Email Routing Rules | Edit | Creating and deleting the routing rules, and setting the catch-all. |
| Email Routing Addresses | Read | Showing which destination addresses are verified, for apps that also send email. Optional. |

The token link in setup includes all of them. Zone and DNS are shared with
[custom domains](/guides/custom-domains/).

The link names the two Email Routing permissions with keys that Cloudflare's token
template page does not list (`email_routing_rule` and `email_routing_address`); they
follow the dashboard's naming for every listed key. Once, after opening the link,
check that **Email Routing Rules** (Edit) and **Email Routing Addresses** (Read) are
selected. If they are not, add them by hand. If the token lacks one, the install form
says which. Edit the Appflare token under **API Tokens** in the Cloudflare dashboard,
add the permissions, and save; an edited token keeps its value.

## Installing

For an app that receives email, the install form has an **Email** section:

1. Choose the zone whose email the app should receive. Only active zones are listed.
2. Appflare reads the zone and shows what the install will set up there, without
   changing anything yet.
3. Install as usual. The Install button stays off while something is in the way.

The install then:

- turns Email Routing on for the zone if it is off. Cloudflare adds its MX records
  (`route1`, `route2` and `route3.mx.cloudflare.net`), an SPF record
  (`v=spf1 include:_spf.mx.cloudflare.net ~all`) and a DKIM record, and locks them;
- creates one routing rule per address the app asks for, such as `inbox@example.com`,
  that sends mail to the app's Worker;
- if the app asks for the catch-all, points the zone's catch-all rule at the Worker,
  so mail to every other address at the zone reaches the app.

These show on the app's page under **Email**.

Appflare checks the zone first and refuses, before creating anything, when:

- the zone's mail goes to another provider (it has other MX records) and Email
  Routing is off. Turning it on would replace those records, so Appflare leaves that
  choice to you: turn Email Routing on in the Cloudflare dashboard if you mean to, or
  choose another zone;
- an address the app wants already has a routing rule that delivers somewhere else;
- the catch-all is on and already delivers somewhere else (a catch-all set to drop
  counts as free);
- the zone would pass Cloudflare's limit of 200 routing rules.

Appflare never replaces a rule it did not create.

## Sending email

An app with a `send_email` binding can also send. Cloudflare delivers to your
account's **verified destination addresses** for free on every plan: add them in the
Cloudflare dashboard under **Email Service**, **Email Routing**, **Destination
addresses**, and click the link in the verification email. Sending to any other
address needs Email Sending, which requires the Workers Paid plan and a sending
domain set up in Email Service (3,000 emails a month are included, then $0.35 per
1,000). Appflare changes nothing for sending; the app's page reminds you of this under
**Next steps**, and the install form lists the addresses already verified.

## Uninstalling

The uninstall undoes the Email Routing setup first, before it deletes the Worker, so
no mail is sent to a Worker that no longer exists:

1. It deletes each routing rule the install created. A rule you already deleted
   counts as removed.
2. It puts the catch-all back as the install found it (for example off, or set to
   drop), but only if it still delivers to the app. A catch-all you pointed elsewhere
   since is left alone.
3. If this install turned Email Routing on for the zone, it turns it off again, which
   removes the MX records, but only when no other routing rule is left there and the
   catch-all is off or set to drop. Otherwise Email Routing stays on.

So Email Routing stays on after an uninstall when:

- another install on the same zone still has routing rules or the catch-all there;
- another install (or you, in the dashboard) turned it on. Only the install that
  turned it on turns it off. If two email apps share a zone and the one that turned
  routing on is uninstalled first, routing stays on for the other, and uninstalling
  the other later leaves it on too. Turn it off in the dashboard (Email Service,
  Email Routing, Settings) when no app needs it.

If the install found Email Routing already on, the uninstall never turns it off.

Updating or rolling back an app does not change Email Routing yet. If a new version
asks for other addresses, the job log says so; uninstall and install the app again, or
change the rules in the dashboard.

## Limits

Cloudflare's limits apply:

- 200 routing rules per domain, and 200 destination addresses per account.
- Messages over 25 MiB are rejected.
- The app's `email` handler runs under the normal Workers limits. On the Workers Free
  plan, a handler that does heavy work per message can run out of CPU time and fail
  to process it; failures show in the Worker's logs.
- An app asks for at most 10 addresses, all in the zone you choose. Subdomains of the
  zone are not set up.
