# Appflare hosted installer

The Worker behind `appflare.dev/api/install/*`. The deploy page on appflare.dev
signs the visitor in to Cloudflare, then drives this API to deploy a signed
Appflare release into the visitor's own Cloudflare account. When Appflare
answers at its address, the deploy page hands the Cloudflare connection to it
directly; this Worker never takes part in that.

It has no public address. The docs Worker forwards `/api/install/*` to it
through a service binding, so the deploy page and this API share one origin.

## How a deploy runs

Every request carries the visitor's short-lived Cloudflare access token as
`Authorization: Bearer` and does one bounded piece of work: at most 40
outgoing requests, so it fits a Worker invocation on Workers Free. Progress
is kept in an installation record, so a closed tab simply stops, and the next
request continues where the last one ended.

The steps:

1. Check the newest Appflare release on GitHub: its Ed25519 signature against
   the keys embedded in `@appflare/schema`, then every file's sha256, before
   anything is uploaded.
2. Create the D1 database `<name>` and the KV namespace `<name>-kv`.
3. Upload the static files, in parts.
4. Upload the Worker with the release's settings and bindings, the vars
   `APPFLARE_INSTALLER_ORIGIN` and `APPFLARE_INSTALL_SOURCE=browser`, and one
   secret, `APPFLARE_HANDOFF` (the sha256 of a secret only the visitor's
   browser knows). Appflare creates its own sign-in secret and credential key
   later; this installer never sees them.
5. Create the Workflow, the cron schedule, turn on workers.dev, and attach
   the chosen custom domain, if any.
6. Wait until Appflare proves, at the chosen address, that it holds the
   handoff secret's hash. Until then the answer is "waiting"; a page that
   merely answers is not enough.

Names that are already in use are refused, and nothing the installation did
not create is ever adopted, replaced or removed: a resource found under one
of its names counts as its own only when it was made while the installation's
own create of it was running. A hostname with DNS records (a wildcard record
that covers it included), another Worker's domain, or a Workers route that
catches it is refused before anything is attached.

## What it stores

One row per unfinished installation in its D1 database (`installations`):

- the Cloudflare account id, the Worker name, the chosen hostname and the
  address Appflare is opened at;
- the release it deploys (version, the exact `manifest.json` and its sha256,
  the zip's URL);
- the sha256 of the installation's key (the key itself is returned to the
  browser once) and the sha256 of the handoff secret;
- the ids of what it created (database, KV namespace, Worker, Workflow,
  custom domain), the current step and its last message.

A row is deleted when Appflare reports that its owner account exists, or when
someone removes the unfinished installation. There is no time-based expiry.

## What it never stores or logs

- Access tokens, refresh tokens, or any other credential. The access token
  lives in the memory of the request that carries it and is sent only to
  Cloudflare's API.
- Anything about Appflare's owner, and no app data.
- In logs: no token, account id, hostname or name. Cloudflare requests are
  logged as method, path with every variable part replaced, and status.
  Automatic invocation logs are turned off, since they would record request
  headers.

## API

All routes are `POST` with a JSON body. Errors are
`{ "error": { "code", "message" } }`, with a message written for the visitor.

| Route | Body | Answer |
|---|---|---|
| `accounts` | `{}` | `{ accounts: [{ id, name, workersDevSubdomain }] }` |
| `zones` | `{ accountId }` | `{ zones: [{ id, name }] }`, active zones only |
| `release` | `{}` | `{ release: { version } }`, the release a new installation would deploy now; for a token Cloudflare accepts, kept 5 minutes |
| `check` | `{ accountId, workerName, hostname }` | `{ workerName: "free" \| "taken", hostname: null \| "free" \| { conflict, detail } }` |
| `installations` | `{ accountId, workerName, hostname, handoffHash }` | `{ installationId, key, release: { version }, address }` |
| `installations/find` | `{ accountId }` | `{ installations: [...] }`, never keys |
| `installations/<id>/step` | `{ key }` | `{ status, step: { id, label }, done, total, retryAfterMs?, message? }` |
| `installations/<id>/handoff-secret` | `{ key, handoffHash }` | `{ ok: true }`, refused once Appflare has its connection |
| `installations/<id>/cleanup` | `{ key? }` | like `step`, with `status` `removed` at the end |
| `installations/<id>/complete` | `{ key }`, no token | `{ ok: true }`; 404 when already gone |

`find`, and `cleanup` without the key, are allowed only when the token can
read the record's account.

## Configuration

Vars in `wrangler.jsonc` (the `production` environment repeats them; wrangler
does not inherit vars into environments):

| Var | Meaning |
|---|---|
| `INSTALLER_ENV` | `production` or `development`. Required. |
| `INSTALLER_ORIGIN` | The deploy page's origin, e.g. `https://appflare.dev`. Appflare answers its handoff only to this origin and reports completion here. |
| `MIN_MANAGER_VERSION` | The oldest Appflare release deployed. Older releases are refused with a plain message. |
| `DEV_RELEASE_URL`, `DEV_RELEASE_KEYS` | Development only. See below. |

A configuration that does not check out makes every request answer 503; the
log names the variables at fault, never their values.

### Testing an unreleased Appflare

To deploy a release that is not on GitHub yet (for example one that adds
something the newest release lacks):

1. Make a key pair with `pnpm --filter @appflare/schema keygen` and give it a
   key id starting with `dev-`.
2. Pack the manager with `pnpm release:pack --key-id dev-<you>` and sign it
   with `appflare-pack sign` and that key (see `docs/RELEASING.md`).
3. Host `manifest.json`, `manifest.sig` and `appflare-<version>.zip` at one
   https URL that answers Range requests.
4. Set `DEV_RELEASE_URL` to that URL and `DEV_RELEASE_KEYS` to the public key
   as the packer prints it, for example in `.dev.vars`, and lower
   `MIN_MANAGER_VERSION` if needed.

These cannot reach production by accident: with `INSTALLER_ENV=production`
either variable being set refuses every request; dev key ids must start with
`dev-`; and dev keys verify only releases read from `DEV_RELEASE_URL`, while
GitHub releases verify only against the embedded Appflare keys.

## Database

`src/db/schema.ts` (Drizzle). After changing it, run
`pnpm --filter @appflare/installer db:generate`. The Worker applies pending
migrations itself on the first request each isolate serves, so a deploy never
needs a separate migration command.

## Deploying

Preview, to the dev account, from the repository root:

```sh
pnpm wrangler -c apps/installer/wrangler.jsonc deploy --env=""
```

Production goes to the account that owns appflare.dev, from CI only:
`wrangler deploy --env production` from a copy of `wrangler.jsonc` without
its `account_id` line, with that account in `CLOUDFLARE_ACCOUNT_ID`. On the
first deploy wrangler creates the `appflare-installer` D1 database; later
deploys find it by name. Deploy this Worker before the docs Worker, whose
service binding points at it.

Run it locally with `pnpm --filter @appflare/installer dev`.
