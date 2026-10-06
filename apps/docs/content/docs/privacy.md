---
title: Privacy
description: What appflare.dev records about visits to its pages, and what Appflare's installer keeps.
---

appflare.dev uses PostHog analytics, including session recordings, heatmaps, error reports
and what visitors search for, to learn how its pages are used, and keeps that data in PostHog's EU region. The
site has no accounts, and the address of your own Appflare stays in your browser: it is
never recorded or sent.

Links from an Appflare to this site say so in their address (`utm_source=appflare-manager`,
with the name of the link and the Appflare version), so the analytics count how many visits
come from Appflare and from which help links. They never say which Appflare sent you.

## Installing Appflare from this site

The page that installs Appflare from your browser, [appflare.dev/deploy](/deploy/), and the
page Cloudflare sends you back to after you connect run no analytics at all. No page views,
clicks, recordings or heatmaps are taken there.

The deploying is done by Appflare's installer, an open-source service behind that page. For
each installation that is not finished yet, it keeps a record so you can continue or remove
it:

- your Cloudflare account id;
- the name and the address you chose;
- the Appflare release it installs;
- what it created in your account, and how far it got.

It keeps no Cloudflare token, no password and nothing about your apps. The record has no
time limit: it is deleted when your new Appflare's owner account is created, or when you
remove the unfinished installation from the deploy page. Your browser remembers the same
installation, with the key that lets you continue it, until then.
