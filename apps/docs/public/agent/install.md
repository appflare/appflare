# Install Appflare: instructions for a coding agent

The user asked you to install Appflare, a self-hosted app manager for Cloudflare, into
their own Cloudflare account. You run commands on their computer; a few steps happen in
their browser and only they can do them. Follow these instructions exactly, in order.

Background, if you need it:

- The install guide: https://appflare.dev/start/install.md
- All of Appflare's documentation for agents: https://appflare.dev/llms.txt

## Rules for the whole session

- Never ask the user for a Cloudflare API token or a password, and never accept one in the chat. If they paste a token anyway, tell them to roll it in the Cloudflare dashboard (My Profile > API Tokens, or Manage Account > Account API Tokens) and to create a new one.
- Never print a secret, and never write one out in a command, a file inside a project, or shell history.
- Change nothing in their Cloudflare account except through the Appflare installer. If the installer refuses because something already exists, stop and ask them. Never delete anything.
- Never use `--allow-unsigned` and never set `APPFLARE_DEV`.
- Work in a new directory outside their projects. The installer writes nothing to the current directory.

## Steps

1. Run `node --version`. Appflare needs Node.js 22 or newer. If it is older, stop and tell the user.
2. Run `npx wrangler whoami`. If it says they are not logged in, run `npx wrangler login`, tell them to approve the request on the page it opens in their browser, and wait until the command finishes.
3. If `whoami` lists more than one account, show them the account names and ask which one to use. Set `CLOUDFLARE_ACCOUNT_ID` to that account's id for every command below.
4. The installer is the npm package `create-appflare`, run as `npx create-appflare`. Type the name exactly: never run an npm package with a similar name, because it would run with the user's Cloudflare login. It downloads the release from GitHub; if GitHub refuses or rate-limits the download, put `GITHUB_TOKEN="$(gh auth token)"` in front of the installer command, which keeps the token out of the output.
5. Ask the user to confirm that the account already has a `workers.dev` subdomain. They can see it, or set one up, under Workers & Pages in the Cloudflare dashboard. Do not run the installer until they confirm: without a subdomain the deploy fails partway, leaves resources behind, and a second attempt is refused.
6. Run the installer with `--yes` (the `--yes` before the package name is npx's own, so it does not ask before downloading the package):
   ```sh
   npx --yes create-appflare --yes
   ```
   Its standard output is the manager's address and nothing else; progress and errors go to the terminal, including `The manager is up (version ...)` once it answers. Keep the address and that version for your summary. If it fails:
   - A Worker, D1 database, or KV namespace named `appflare` (or `appflare-kv`) already exists: stop and ask the user. Do not delete it.
   - Anything else: show them the error and stop. Do not retry or clean up; the error says how to start over, and the user decides.
7. Open the manager's address in the user's browser, for example with `open` on macOS or `xdg-open` on Linux. If you cannot open a browser, show them the address and ask them to open it. The address is not a secret.

## Then give the user this checklist

These steps happen in the setup page you opened, and only the user can do them.

1. Connect Cloudflare: select "Create token". The Cloudflare dashboard opens a token form named Appflare with the permissions already selected: Workers Scripts, Workers KV Storage, D1, Workers R2 Storage, Queues, and Vectorize (Edit); Account Settings and Workers Tail (Read); and, for optional features only, Access: Apps and Policies (Edit) and Access: Organizations, Identity Providers, and Groups (Read) for Cloudflare Access, Zone (Read), DNS (Edit) and Workers Routes (Edit) for custom domains, SSL and Certificates (Edit) with those three for external domains, Zone Settings (Edit), Email Routing Rules (Edit) and Email Routing Addresses (Read) for apps that receive email, and Billing (Read) for detecting the Workers plan. Choose the account Appflare was installed in, create the token, copy it, and paste it into the setup page, never into the chat. Select Continue, which checks and saves it in one step. The page refuses a token for another account. An account-owned token needs the Super Administrator role; otherwise use "Create a user token instead".
2. Create the owner account in the same browser: a name, an email, and a password of at least 12 characters that they choose. Do not suggest a password.
3. Read what the account can run on the last setup screen. A bar shows how many things are ready; each row shows Ready, Needs action (an app they installed needs it), Not set up (off, and nothing needs it yet), Paid plan only, or Could not check, with one button for what is off (Turn on in Cloudflare, Edit token in Cloudflare, Choose plan, or Set up) and Details for what Appflare found. Select Check again after changing something, then Finish. The same list stays in Settings > Your account > What this account can run.
4. Optional: to install apps that store files in R2, enable R2 in the Cloudflare dashboard under R2 Object Storage. Cloudflare asks for a payment method first, although R2's free tier costs nothing.
5. Optional: to put the manager behind Cloudflare Access (Protect with Cloudflare Access, in Settings > Users and sign-in > Cloudflare Access), create a Zero Trust organization in the Cloudflare dashboard first. Its Free plan covers up to 50 users.
6. Optional: to serve apps on domains whose DNS is managed outside this account (external domains), turn on Cloudflare for SaaS for one domain of the account in the Cloudflare dashboard (that domain, SSL/TLS, Custom Hostnames, Enable), then set up the gateway in Settings > Domains > External domains. Cloudflare asks for a payment method first; 100 external domains are included, then each costs $0.10 a month.

## If setup asks where Appflare should live

When the account has an active domain, setup shows "Where should Appflare live?" after the owner account. Tell the user to keep the workers.dev address (the default; select Continue) unless they asked you for Appflare on a domain. If they did, they choose "Use a domain of yours", pick the domain and name, and select Continue. The move can take a few minutes while Cloudflare issues the certificate (up to 15); the page shows its progress. Then they sign in again at the new address, where setup goes on. They can also choose a domain later in Settings > Domains > Appflare's address. Guide: https://appflare.dev/guides/appflare-address.md

## End with

The manager's URL, the version the installer reported (or that the manager had not answered yet), and anything that did not work. After setup, everything else happens in the manager: updates in Settings > Updates (`/settings/updates#appflare` on the manager's address), sandbox builds in Settings > Building apps (`/settings/building#sandbox`), and removal in Settings > Your account > Danger zone (`/settings/account#danger-zone`).
