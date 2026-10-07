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

[![Install Appflare](https://img.shields.io/badge/Install_Appflare-appflare.dev%2Fdeploy-fb6b00)](https://link.appflare.dev/deploy)

[Install Appflare](https://link.appflare.dev/deploy) from your browser: sign in to
Cloudflare, choose the account and Appflare's address, and the page deploys Appflare
into your account. Nothing to install on your computer. See
[Install from your browser](https://appflare.dev/start/browser-install/).

Or use Cloudflare's Deploy button:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://link.appflare.dev/deploy-1c)

The button copies a prebuilt Appflare into your Git account and deploys it; afterwards
Appflare updates itself and you can remove the copy. See
[Deploy with the button](https://appflare.dev/start/deploy-button/).

From a terminal, `npx create-appflare` installs it too. See
[Install Appflare](https://appflare.dev/start/install/).

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
