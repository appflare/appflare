<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo_full_white.svg">
    <img alt="Appflare" src="docs/assets/logo_full.svg" width="240">
  </picture>
</h1>

<p align="center"><strong>An app store for your own Cloudflare account.</strong></p>

<p align="center">
  <a href="https://appflare.dev"><img alt="Documentation" src="https://img.shields.io/badge/docs-appflare-f38020"></a>
  <a href="https://github.com/appflare/appflare/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/appflare/appflare/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
</p>

Install and manage 100+ open-source apps, including [OpenSEO](https://appflare.dev/apps/open-seo/),
[Sink](https://appflare.dev/apps/sink/) and [Counterscale](https://appflare.dev/apps/counterscale/).
Appflare sets up each app and gives you one dashboard for updates, custom domains
and access control. Your apps run in your own Cloudflare account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://link.appflare.dev/deploy)

[Browse the apps](https://appflare.dev/apps/) · [Installation guide](https://appflare.dev/start/install/) · [Documentation](https://appflare.dev) · [App catalog repository](https://github.com/appflare/catalog)

[![Appflare with a gallery of apps you can install in your own Cloudflare account](docs/assets/readme-hero.png)](https://appflare.dev/apps/)

## Install Appflare

Use the **Deploy to Cloudflare** button above to install from your browser. You
need a Cloudflare account and a GitHub or GitLab account. The button copies Appflare
into your Git account and deploys it, then the setup wizard connects Cloudflare and
creates your owner account. You can delete the copy after setup.
[The browser setup guide](https://appflare.dev/start/deploy-button/) walks through each step.

Or run the installer with **Node.js 22 or newer**:

```sh
npx create-appflare
```

You can also [give the installation prompt to a coding agent](https://appflare.dev/start/install/).
All three methods install the same Appflare release into your account.

Appflare is free and open source. It runs on the free Workers plan, and most
catalog apps do too. Each app's page shows whether it needs Workers Paid. Apps count
against your own Cloudflare plan, and some use third-party services with their own
pricing.

## What you can do

- Browse apps for analytics, email, files, AI, productivity and more, then install them from your browser.
- Update apps when a new version is available. Automatic updates are off until you turn them on.
- Follow installs and updates in a live log, and roll back to an earlier app version when supported.
- Give apps custom domains and protect them with Cloudflare Access.
- Change app settings, or remove apps along with their resources.

Appflare creates each app's Cloudflare resources, such as databases and storage.
Installed apps don't need Appflare to run, so they keep running if it stops or
you remove it.

## Contribute

[Report a bug or suggest a feature](https://github.com/appflare/appflare/issues),
or open a pull request to improve the manager, installer or documentation.
To add an app, use the [catalog repository](https://github.com/appflare/catalog)
and [submission guide](https://appflare.dev/catalog/submit/).

For development, use Node.js 22 or newer and pnpm 10. The repository's
[`package.json`](package.json) pins the pnpm version.

```sh
git clone https://github.com/appflare/appflare.git
cd appflare
pnpm install --frozen-lockfile
pnpm check
```

The [manager](apps/manager), [installer](packages/cli), [catalog packer](packages/pack)
and [documentation site](apps/docs) live in this repository.

## Documentation

Find setup instructions and guides at [appflare.dev](https://appflare.dev):

- [What Appflare is](https://appflare.dev/start/overview/)
- [Install Appflare](https://appflare.dev/start/install/)
- [Install an app](https://appflare.dev/guides/install-apps/)
- [Update and roll back](https://appflare.dev/guides/updates/)
- [Custom domains](https://appflare.dev/guides/custom-domains/)
- [Submit an app to the catalog](https://appflare.dev/catalog/submit/)
- [Security model](https://appflare.dev/security/)
- [FAQ](https://appflare.dev/faq/)

## License

[Apache-2.0](LICENSE). Catalog apps have their own licenses, shown on their app pages.

Appflare is an independent open-source project and is not affiliated with, endorsed by,
or sponsored by Cloudflare, Inc.
