<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo_full_white.svg">
    <img alt="Appflare" src="docs/assets/logo_full.svg" width="280">
  </picture>
</h1>

<p align="center">
  <a href="https://appflare.dev"><img alt="Documentation" src="https://img.shields.io/badge/docs-appflare-f38020"></a>
  <a href="https://github.com/appflare/appflare/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/appflare/appflare/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
</p>

Appflare is one Worker in your own Cloudflare account that installs apps from a
catalog and keeps them updated.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/appflare/deploy)

The button copies a prebuilt Appflare into your Git account, deploys it to your
Cloudflare account, and opens the setup wizard; afterwards Appflare updates itself
and you can remove the copy. See [Deploy with the button](https://appflare.dev/start/deploy-button/).

Two other ways to install:

- **The installer:** run `npx create-appflare` in a terminal. See [Install Appflare](https://appflare.dev/start/install/).
- **An AI agent:** paste a prompt into a coding agent, and it runs the installer for you. See [Install with an AI agent](https://appflare.dev/start/install-with-an-agent/).

Status: early. Expect rough edges and breaking changes before the first stable release.

## Documentation

The documentation lives at
[appflare.dev](https://appflare.dev):

- [What Appflare is](https://appflare.dev/start/overview/)
- [Install Appflare](https://appflare.dev/start/install/)
- [Install an app](https://appflare.dev/guides/install-apps/)
- [Submit an app to the catalog](https://appflare.dev/catalog/submit/)
- [Security model](https://appflare.dev/security/)
- [FAQ](https://appflare.dev/faq/)

Its source is in [`apps/docs`](apps/docs).

Appflare is an independent open-source project and is not affiliated with, endorsed by,
or sponsored by Cloudflare, Inc.

License: Apache-2.0.
