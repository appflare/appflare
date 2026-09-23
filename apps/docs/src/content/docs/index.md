---
title: Appflare
description: A self-hosted app manager for Cloudflare. One Worker in your own account installs, updates, and removes Cloudflare-native apps.
template: splash
hero:
  tagline: A self-hosted app manager for Cloudflare. One Worker in your own account installs, updates, and removes Cloudflare-native apps.
  actions:
    - text: Install Appflare
      link: /start/install/
      icon: right-arrow
    - text: What Appflare is
      link: /start/overview/
      variant: minimal
---

## How it works

You run `npx create-appflare`. It deploys one Worker, the manager, into your
Cloudflare account. The manager has a web UI where you browse a catalog of apps
that run on Workers.

:::note[Not on npm yet]
The installer is not published to npm yet. Until it is, run it
[from a checkout](/start/install/#from-a-checkout) of this repository.
:::

When you install an app, the manager creates what the app needs (KV namespaces, D1
databases, R2 buckets, queues, Vectorize indexes, secrets, cron triggers) and
records each one. Because it knows every resource it created, it can update the app
later, roll it back, and remove it cleanly.

Every app in the catalog is built from a pinned upstream commit, packed and signed
by the catalog's CI. The manager installs nothing whose signature does not verify.

## Where to go next

- [What Appflare is](/start/overview/), and what it is not.
- [Install Appflare](/start/install/) into your account.
- [Install an app](/guides/install-apps/) from the catalog.
- [Submit an app](/catalog/submit/) to the catalog.
- [Security model](/security/): what the manager does with your API token.

Appflare is an independent open-source project. It is not affiliated with,
endorsed by, or sponsored by Cloudflare, Inc.
