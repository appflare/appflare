# appflare.dev

The public site: Appflare's documentation, the catalog's pages, the install pages
and the Install badge. Fumadocs on TanStack Start, prerendered in full and served
as static files only; no Worker code runs for a request. `_headers` sets the
response headers.

The site's address is `SITE_URL` in `@appflare/schema/links`. The manager, the
installer and the site itself all link through it.

## Work on it

```sh
pnpm --filter @appflare/docs dev      # local server
pnpm --filter @appflare/docs build    # the whole site, into dist/client
pnpm --filter @appflare/docs test
```

## Where it is deployed

`.github/workflows/docs.yml` builds the site once and deploys the same files twice:

1. **Preview**, to the development account at
   `https://appflare-docs.appflare-dev.workers.dev`. Every run. The workflow
   checks that the preview answers before it goes on. Links inside the site are
   relative, so the preview can be browsed; absolute links (OpenGraph, sitemap,
   `llms.txt`) still name appflare.dev.
2. **appflare.dev**, the wrangler environment `production`, to the account that
   owns the `appflare.dev` zone. Only after the preview deployed.

It runs on every push to `main` that touches the site, once a day, and when the
catalog publishes. To deploy by hand:

```sh
gh workflow run docs.yml --ref main                # preview, then appflare.dev
gh workflow run docs.yml --ref main -f target=dev  # preview only
```

Nothing in this repository holds the production account's id or token. The
checked-in `wrangler.jsonc` stays pinned to the development account, so a local
`pnpm wrangler -c apps/docs/wrangler.jsonc deploy --env=""` can only reach the
preview.
Because wrangler prefers a config's `account_id` over `CLOUDFLARE_ACCOUNT_ID`, the
production job deploys from a copy without that line
(`apps/docs/wrangler.production.json`, written during the run and gitignored)
and passes the account in `CLOUDFLARE_ACCOUNT_ID`.

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
     the site's files, and attaches the custom domain.
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
