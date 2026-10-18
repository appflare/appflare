# @appflare/manager

## 0.5.1

### Patch Changes

- f2b836a: Changed: Moving Appflare to a new address keeps waiting up to an hour while the certificate is still being issued.
- f091a4e: Fixed: A move to the domain chosen at install no longer fails when Cloudflare never started its job; Appflare starts it again by itself.
- f2b836a: Changed: The Anonymous report now names why a job failed in more cases, as a word from a fixed list, never your text.
- 973e0ac: Fixed: When Cloudflare's list of container applications comes back unreadable, sandbox and app jobs and the removal review stop and say so instead of reading it as no applications.
- c0a1cfa: Fixed: On Workers Free, an install stops before changing anything when the account has no room for its cron triggers, D1 databases, Hyperdrive or Vectorize, and removes itself if its cron triggers are refused later.
- 973e0ac: Fixed: A job marked failed because Cloudflare reported it missing no longer runs, or changes the app, if Cloudflare starts it later after all.
- f2b836a: Fixed: Pausing or resuming an app of many Workers could fail, or take 5 minutes longer on Workers Free.
- f091a4e: Fixed: Removing Appflare and disabling sandbox builds find the sandbox Worker's container applications by what they back, so ones a newer release added, or a stopped removal left, go too.
- f091a4e: Fixed: Enabling sandbox builds replaces container applications a deleted sandbox Worker left behind, instead of asking you to delete them.
- c0a1cfa: Fixed: An app whose Worker was deleted in the Cloudflare dashboard can be uninstalled again, and pausing or resuming it says why it cannot.
- c0a1cfa: Fixed: An install could fail with "Completion token has already been consumed" after Cloudflare was slow to answer its upload.
- c0a1cfa: Fixed: An app whose startup was too slow for Cloudflare once is uploaded again; if it happens twice, the message says trying again often works.
- Updated dependencies [973e0ac]
- Updated dependencies [c0a1cfa]
- Updated dependencies [f091a4e]
- Updated dependencies [f091a4e]
  - @appflare/cf-api@0.4.1

## 0.5.0

After updating, reconnect Cloudflare once when Appflare asks, so it can read usage (Account Analytics: Read).

### Added

- **Spend protection.** Appflare reads each app's usage from Cloudflare every 5 minutes and tells you when one runs far above its normal.
- **Usage tab** on every app: a chart per product, this month's use and cost estimates at Cloudflare's prices.
- **Usage on Home:** this month's cost, the projected month and what's burning now, or on Workers Free the closest daily limit, with a 7-day chart by app.
- **Pause and Resume.** A paused app serves a "paused" page and keeps its data, bindings and secrets. Resume puts back the exact versions.
- **Automatic pausing** (off by default) for an app that loops, and on Workers Paid one past its spending cap or the monthly budget. Settings > Your account > Spend protection.
- **Usage alerts** written as a sentence, such as "when it has spent $6.00 this month".
- **Notifications** for unusual usage, usage alerts, free daily limits, pauses and the monthly budget. Existing channels get them; untick any you don't want.
- **Account-wide free limits (Workers Free).** Daily limits count the whole account, and Appflare warns at 90% even when something else used it.
- Turn Workers Logs on or off for all of an app's Workers at once.

### Changed

- The scheduled check runs every 5 minutes instead of every 30.
- Appflare no longer asks for Workers Tail access.
- Settings > Usage data is now Settings > Anonymous report. Old links still work.

### Fixed

- A page could stop loading after an update until the browser cache was emptied.
- Updating an app no longer turns its Workers Logs off.
- Uninstalling an app also removes its queue consumers and container applications, so nothing keeps running or billing.

## 0.4.3

### Changed

- Usage data tells Cloudflare Access failures apart and carries a short excerpt of Cloudflare's error, with names, ids, addresses and tokens taken out.

### Fixed

- **Cloudflare Access.** Protecting an app no longer fails when an Access application you made for a broader pattern, such as `*.example.com`, already covers it.
- An Access application you made for one of a protected app's hostnames keeps that hostname, and Protect again no longer refuses because of it.
- An app with more domains than one Access application can hold (50) gets a clear message instead of Cloudflare's error.
- Apps whose D1 SQL has a trigger with `CASE ... END;`, such as EdgeChat, now install and update.

## 0.4.2

- Updated dependencies.

## 0.4.1

### Added

- An app built from a template or fork also shows its main repository.

### Changed

- The catalog scrolls smoothly on a phone, and All apps and search results show two apps to a row.

## 0.4.0

If an earlier version left a `SANDBOX` binding with no service on your Appflare Worker, updating stops. Remove that binding once in the Cloudflare dashboard (Workers & Pages > your Appflare Worker > Settings > Bindings), then update.

### Added

- **Install from the browser.** A web page can install Appflare, hand it the Cloudflare connection and open setup, where you create the owner account.
- **Cloudflare sign-in.** Appflare can connect with Cloudflare sign-in instead of an API token and renews its access by itself. API tokens keep working.
- **Reconnect Cloudflare** in Settings > Your account, or switch between Cloudflare sign-in and an API token there. Your apps keep running.
- **Bigger apps on Workers Free.** Apps of up to 24 Workers install and update on Workers Free; jobs pause for 5 minutes when they need to.
- **Updates that add a database or stream.** An update that adds Hyperdrive or Pipelines no longer needs a fresh install; the update dialog asks for what it needs.
- **Email Routing follows the version.** Updates and rollbacks change an email app's routing rules to match, and Set up email again finishes any part left out.
- An app of several Workers can have another Worker receive its mail, and give each Worker its own value of a secret.
- Install again for a failed install from a repository or a source build, reusing that same build.
- Workflows get the limits, concurrency, schedules and retention from the app's wrangler config.
- Apps can set Hyperdrive query caching, and settings can use `{{emailDomain}}` and `{{emailZoneId}}`.

### Changed

- Appflare reads better on a phone: failed jobs say what did not finish in a plain sentence, and the connection card keeps details behind Details.
- A tab left open at the workers.dev address follows Appflare when it moves to its domain.
- Every domain picker has a search box, and the install form and app settings look and behave alike.
- Updating Appflare from the sidebar and throwing a build away now ask first.
- Screen readers announce errors and success messages as they appear, and the keyboard focus no longer drops to the top of the page.
- Cloudflare dashboard addresses in errors are links, an app token link selects Images when needed, and Add external domain waits for the gateway.
- Builds made for review that nobody uses are deleted after 7 days.
- Pre-releases of Appflare send no usage data.
- Sign-in runs on Better Auth 1.7.7. Sessions, passwords and passkeys keep working.

### Fixed

- Checking for Appflare updates no longer fails most of the time because of GitHub's rate limit.
- Disabling sandbox builds now leaves them off, and enabling them again works.
- A failed install or update no longer leaves resources that the next attempt refuses; an uninstall deletes them.
- The first update after an install no longer warns that Cloudflare serves another version than Appflare recorded.
- Turning Cloudflare Access off no longer ends with "health: not verified yet" for an app that serves.
- Appflare reads its own version from its build, not from a setting anyone could edit.

## 0.3.1

### Added

- The install form checks whether a name on one of your domains is already in use, and says what happens if it is.
- Bare `https://` addresses in an app's Next steps and in What's new are links.

### Fixed

- Notifications and job pages name a failed install by the app's name instead of its catalog id.

## 0.3.0

### Added

- **Install again.** An install that did not finish can be installed again once its cause is fixed, from the form filled in from last time.
- **A redesigned install form.** One address control with a searchable domain list, a status line that never moves the layout, and grouped fields.
- Catalog secrets and vars can show a link beside their field, and an app can open at a path such as `/dashboard`.

### Changed

- An app whose catalog entry changed how it is installed is offered as a reinstall instead of an update that would be refused.

### Fixed

- Apps that start a Workflow, such as OpenSEO's site audits, no longer fail with "Workflow does not exist".
- Protecting an app with Cloudflare Access checks the Zero Trust organization and token permissions before it creates anything.
- A custom domain added a moment ago shows "Being set up" instead of "Unhealthy" while Cloudflare issues its certificate.

## 0.2.0

This version adds a column to the database, so Roll back in Appflare cannot return from it to an earlier version. Roll back from the Cloudflare dashboard instead.

### Added

- **Cloudflare Access for apps.** Protect an app from the install form or its Domains tab. Every Appflare user gets in, and health checks still reach it.
- Catalog entries can require or recommend protection and keep listed paths public.
- Apps of several Workers can run a Workflow that another of their Workers defines.

### Changed

- Health checks no longer count Cloudflare Access's sign-in page as the app answering; such an app shows "Behind Cloudflare Access".
- Removing Appflare keeps protected apps' Access applications, so those apps keep asking for a sign-in.
- The loading indicator no longer pauses on the full logo, which made it look finished.
- Links to appflare.dev say they came from Appflare, so the site can count those visits. They still send no referrer.

### Fixed

- Installing an app with Protect with Cloudflare Access on no longer fails at "cover the app's Workers with Cloudflare Access".
- Turning Access on, or moving Appflare's address, now notices an existing Access application that covers the address through its destinations.

## 0.1.0

### Added

- **First public release.** Appflare is a self-hosted app manager that runs as one Worker in your own Cloudflare account.
- Installs apps from the catalog or from a GitHub repository, creates the resources each needs, and removes them with the app.
- Checks the signature and file hashes of every release before anything reaches your account.
- Updates apps when you choose or automatically, rolls them back, and updates itself from its own signed releases.
- Custom and external domains for apps, and a domain of your own for Appflare.
- Several users signing in with a password or a passkey, optionally behind Cloudflare Access.
- Health checks, jobs with their own logs, and notifications when something finishes or needs attention.
