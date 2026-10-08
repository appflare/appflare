# appflare.dev

The public site: Appflare's documentation, the catalog's pages, the install pages,
the Install badge, and the deploy page (`/deploy/`), which installs Appflare from the
browser. Fumadocs on TanStack Start, prerendered in full and served as static
files. `_headers` sets the response headers; the build adds the deploy pages' own
(see below).

`worker/index.ts` runs before the static files for the pages and
`/api/install/*` (`run_worker_first`; the build's assets, screenshots, OpenGraph
images and agent files skip it). It forwards `/api/install/*`, unchanged, to the
hosted installer (`apps/installer`, the Worker `appflare-installer`) through a
service binding, so the deploy page and the installer's API share one origin. The
Worker keeps no logs, since those requests carry the visitor's Cloudflare access
token. A page asked for with `Accept: text/markdown` gets its Markdown (the `.md`
the build writes next to it, `llms.txt` for the front page) instead of its HTML;
every other request gets the static files' own answer.

## For search engines and agents

- `robots.txt` (in `public/`) lets every crawler in, states the site's Content
  Signals, and names `sitemap.xml`. Cloudflare puts its Content Signals Policy
  comments above it.
- `sitemap.xml` gives each app's page the day the catalog last tested the app.
- App pages and the front page carry schema.org JSON-LD
  (`src/lib/structured-data.ts`); docs pages link their Markdown as a
  `text/markdown` alternate.
- The front page's response has `Link` headers (`_headers`) to `llms.txt` and
  the agent skills index.
- `/.well-known/agent-skills/` publishes the instructions in `public/agent/` as
  Agent Skills, with an index of their digests (`src/lib/agent-skills.ts`).

https://isitagentready.com scores the site on these.

## The deploy page

`/deploy/` signs the visitor in to Cloudflare (OAuth with PKCE, Appflare's public
client), lets them choose the account, name and address, then drives the hosted
installer and hands the Cloudflare connection to the new Appflare from the
browser. `/deploy/callback` is the OAuth return address. It also sends a
manager's Reconnect Cloudflare back to that manager: it shows the manager's
address, and only when the visitor confirms it is theirs does it post `code` and
`state` (or Cloudflare's `error`) as a form to `<address>/api/cloudflare/oauth-return`,
which reports the outcome. Without that confirmation anyone could start
Appflare's genuine consent with their own address and collect the code. The logic
is in `src/deploy/`, the steps' drawing in `src/components/deploy/`.

- **Tokens.** The access and refresh token live in the tab's memory and
  `sessionStorage` only. The refresh token goes to the new Appflare and nowhere
  else; the installer gets the access token. `localStorage` keeps only the
  unfinished installation (`{ installationId, key, handoffSecret, accountId }`).
- **No analytics.** PostHog never loads in a page opened at `/deploy/…`, and the
  router reloads the page rather than moving there from another page.
- **Headers.** After prerendering, the build hashes each deploy page's inline
  scripts into a strict Content-Security-Policy for its exact path (`/deploy/`,
  `/deploy/callback`) and appends it to `dist/client/_headers`, with
  `Referrer-Policy: no-referrer` (`src/build/deploy-headers.ts`). Only the
  callback may submit a form elsewhere: to an https address, or a local one while
  developing.
- **Signing in while developing.** Cloudflare returns only to the client's
  registered callbacks, `https://appflare.dev/deploy/callback` and the preview's,
  so a local server (`localhost`) cannot finish a sign-in with the public client:
  the page says so. To try the whole journey, deploy the preview, or build with
  `VITE_APPFLARE_OAUTH_CLIENT_ID` and `VITE_APPFLARE_OAUTH_CALLBACK_URL` naming
  another OAuth client whose registered callback is on the page's own origin.

The site's address is `SITE_URL` in `@appflare/schema/links`. The manager, the
installer and the site itself all link through it.

## Work on it

```sh
pnpm --filter @appflare/docs dev      # local server
pnpm --filter @appflare/docs build    # the whole site, into dist/client
pnpm --filter @appflare/docs test
```

## Where it is deployed

`.github/workflows/docs.yml` builds the site once and deploys the same files twice,
each time after deploying the hosted installer to the same account (the site's
service binding points at it):

1. **Preview**, to the development account at
   `https://appflare-docs.appflare-dev.workers.dev`. Every run. The workflow
   checks that the preview answers, `/deploy/` with its headers and
   `/api/install/*` through to the installer included, before it goes on. Links
   inside the site are relative, so the preview can be browsed; absolute links
   (OpenGraph, sitemap, `llms.txt`) still name appflare.dev.
2. **appflare.dev**, the wrangler environment `production`, to the account that
   owns the `appflare.dev` zone. Only after the preview deployed.

The installer's `INSTALLER_ORIGIN` must be the origin of the site it sits behind
(the preview at the top level of its config, `https://appflare.dev` in
`production`); the workflow checks both.

It runs on every push to `main` that touches the site, once a day, and when the
catalog publishes. To deploy by hand:

```sh
gh workflow run docs.yml --ref main                # preview, then appflare.dev
gh workflow run docs.yml --ref main -f target=dev  # preview only
```

To deploy the preview by hand, from the repository root, installer first:

```sh
pnpm --filter @appflare/docs build
pnpm wrangler -c apps/installer/wrangler.jsonc deploy --env=""
pnpm wrangler -c apps/docs/wrangler.jsonc deploy --env=""
```

Nothing in this repository holds the production account's id or token. The
checked-in `wrangler.jsonc` files stay pinned to the development account, so a
local deploy can only reach the preview.
Because wrangler prefers a config's `account_id` over `CLOUDFLARE_ACCOUNT_ID`, the
production job deploys from copies without that line
(`apps/docs/wrangler.production.json` and `apps/installer/wrangler.production.json`,
written during the run and gitignored) and passes the account in
`CLOUDFLARE_ACCOUNT_ID`.

## Setting up appflare.dev

Until both secrets below exist, the production job skips with a notice and the
run still succeeds.

1. **The zone.** `appflare.dev` is an active zone in the production account. The
   bare domain needs no DNS record: the first deploy makes `appflare.dev` a
   Workers custom domain, with its DNS record and certificate, and replaces any
   existing record for that name.
2. **An API token** for that account (My Profile › API Tokens › Create Custom
   Token) with:
   - Account › **Workers Scripts** › Edit, for the production account: uploads
     the site's files and the installer, and attaches the custom domain.
   - Account › **D1** › Edit, for the production account: the installer's first
     deploy creates its database, `appflare-installer`.
   - Zone › **Workers Routes** › Edit, for the zone `appflare.dev`: Cloudflare
     asks for it to add a custom domain to a zone, and wrangler lists the zone's
     Worker routes on every deploy.
   - Zone › **Zone** › Read, for the zone `appflare.dev`: wrangler looks up the
     zone by name before it deploys routes.

   Account Settings Read and Memberships Read are not needed: wrangler reads
   them only to choose an account when none is given. DNS Edit is not needed
   either; the custom domain creates its own record. If the first deploy is
   refused while it adds the domain, add Zone › DNS › Edit for `appflare.dev`.
3. **Two repository secrets** on `appflare/appflare` (Settings › Secrets and
   variables › Actions), with exactly these names:
   - `DOCS_CLOUDFLARE_API_TOKEN`: the token above.
   - `DOCS_CLOUDFLARE_ACCOUNT_ID`: the production account's id. The job refuses
     the development account's id.

   ```sh
   gh secret set DOCS_CLOUDFLARE_API_TOKEN --repo appflare/appflare
   gh secret set DOCS_CLOUDFLARE_ACCOUNT_ID --repo appflare/appflare
   ```
4. **Deploy:** `gh workflow run docs.yml --ref main`. A new custom domain can take
   a few minutes to get its certificate; until then the job's last check warns
   instead of failing.
5. **Redirect `www` to the bare domain**, once, in the Cloudflare dashboard for the
   `appflare.dev` zone. The site is static files only, so the redirect is a zone
   setting rather than code:
   - DNS › Records › Add record: type `AAAA`, name `www`, IPv6 address `100::`,
     Proxied. The address is a placeholder; the record only has to exist and be
     proxied so Cloudflare answers for `www`.
   - Rules › Overview › Create rule › Redirect Rule, from the template
     **Redirect from WWW to Root**: status 301, path and query string kept.

   Until both exist, the job's last check warns that the rule is not set up yet.
