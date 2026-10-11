---
title: Privacy
description: What appflare.dev records about visits to its pages, and what Appflare's installer keeps.
---

appflare.dev uses PostHog analytics, including session recordings, heatmaps, error reports
and what visitors search for, to learn how its pages are used, and keeps that data in PostHog's EU region. Your browser
sends it through the site's own address, `swgo.appflare.dev`, which passes it on to PostHog. The
site has no accounts, and the address of your own Appflare stays in your browser: it is
never recorded or sent.

Links from an Appflare to this site say so in their address (`utm_source=appflare-manager`,
with the name of the link and the Appflare version), so the analytics count how many visits
come from Appflare and from which help links. They never say which Appflare sent you.

Links that install Appflare go through `link.appflare.dev`, which counts clicks and
their UTM source and placement before redirecting to the deploy page.

## Installing Appflare from this site

The page that installs Appflare from your browser, [appflare.dev/deploy](https://link.appflare.dev/deploy?utm_source=appflare-docs&utm_medium=website&utm_campaign=appflare&utm_content=privacy-install-1), and the
page Cloudflare sends you back to after you connect do not load PostHog. No page views,
clicks, recordings or heatmaps are taken there.

To learn how far installs get and where they stop, those pages send PostHog one short
message for each step an install reaches, once per step. Each message holds only:

- the step: the first screen, leaving for Cloudflare to connect, back from Cloudflare,
  deploying, deployed, or an error;
- for an error, its kind from a fixed list, such as `deploy-failed:worker` or `declined`,
  never the error's text;
- a random id made for one install and kept in that browser tab until it closes, so the
  steps of one install are counted together. Trying again after an error, or starting
  over, keeps the same id, and a step already sent is not sent again. The tab makes a new
  id only for an install after one that was deployed, or, if the browser refuses to keep
  it, each time the page loads. It is not the id PostHog gives you on the rest of this
  site, so the steps cannot be tied to your visit.

Nothing else: no Cloudflare account, no name or address you chose, no token, no page
address, no cookie. Each message asks PostHog not to make a profile and not to look up a
location, and gives `0.0.0.0` as the IP address, which replaces the one PostHog would
otherwise store.

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
