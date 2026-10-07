---
title: Appflare's Cloudflare connection
description: How Appflare connects to your Cloudflare account, Reconnect Cloudflare, switching between Cloudflare sign-in and an API token, and withdrawing Appflare's access.
---

Appflare needs access to your Cloudflare account to install, update and remove apps.
**Settings > Your account > Cloudflare connection** shows the account and Worker it runs
as, how it connects, since when, and whether that works. **Details** shows the
technical side. Only admins can change the connection; members see where it happens.

## Two ways to connect

**Cloudflare sign-in.** You signed in to Cloudflare and allowed Appflare's permissions.
Appflare installed [from your browser](/start/browser-install/) starts this way. The
connection has every permission Appflare uses, except Billing, which Cloudflare does not
offer to apps that sign in. Appflare gets a fresh access token from Cloudflare when it
needs one, each valid for an hour, and renews by itself. The connection is kept
encrypted in Appflare's D1 database, under a key in its own Worker secret,
`CF_GRANT_KEY`.

**An API token.** You created a token in the Cloudflare dashboard and pasted it into
Appflare. Installs with [the button](/start/deploy-button/) or
[the command line](/start/install/#advanced-install-from-the-command-line) start this way. The token has the permissions you gave it, and the optional
ones can be left out. Appflare keeps it as the encrypted Worker secret `CF_API_TOKEN`.

Either way the credential stays in Appflare: it is never shown again, never logged,
and never given to an app. See [Security model](/security/#appflares-cloudflare-connection).

## Reconnect Cloudflare

A Cloudflare sign-in can stop working. Someone may have withdrawn Appflare's access in
their Cloudflare profile, or the authorization may have run out: Cloudflare does not
promise it lasts forever. Appflare also asks to be reconnected when the running version
cannot read its saved connection, for example after its `CF_GRANT_KEY` secret was
deleted. A moment when Cloudflare does not answer does not count. Appflare retries
those.

Then **Settings > Your account > Cloudflare connection** shows **Needs reconnecting**,
and admins see **Appflare needs to be reconnected to Cloudflare** under **Needs
attention** on Home, with **Reconnect Cloudflare**. Jobs that need Cloudflare stop and
say that an administrator must reconnect it.

While Appflare is disconnected, your apps keep running: they are ordinary Workers and
do not depend on Appflare. You can still sign in to Appflare and look around. It cannot
install, update or remove apps, or update itself, until an admin reconnects.

Select **Reconnect Cloudflare**. It offers two ways, and Appflare never picks one for
you.

### Sign in with Cloudflare

This restores every permission Appflare uses at once.

1. Choose **Sign in with Cloudflare**, then **Continue to Cloudflare**. The tab goes to
   Cloudflare.
2. Sign in, choose the account Appflare runs in, and allow every permission.
3. Cloudflare sends you to appflare.dev, which shows **Return to your Appflare at** and
   an address. Check that it is your own Appflare's address, then select **Return to my
   Appflare**. The page asks because anyone can start a Cloudflare sign-in that names
   their own address, and whoever runs that address gets access to your account.
4. Back in **Settings > Your account**, a banner says how it went.

Finish within 10 minutes, in the same tab. A sign-in works once; to try again, start
again with **Reconnect Cloudflare**. Appflare checks the result before it changes
anything: a sign-in for another account, or one that leaves a permission out, changes
nothing and says so.

appflare.dev only passes along the one-time code Cloudflare returns. The code is useless
without a secret your Appflare kept for itself when you started, and Appflare's hosted
installer takes no part.

If Appflare used an API token before, it removes the `CF_API_TOKEN` secret from its
Worker once the sign-in is stored. The token itself still exists in Cloudflare: delete
it under **API Tokens** in the dashboard. If Appflare could not remove the secret, the
banner says so.

### Use an API token

Choose **Use an API token**. Create the token in the Cloudflare dashboard with the same
form as in setup (see [Connect Cloudflare](/start/install/#1-connect-cloudflare) for the
permissions), paste it, and save. Appflare checks that the token is active and belongs
to the account Appflare runs in before it changes anything.

If Appflare connected with Cloudflare sign-in before, it now uses the token and
withdraws its sign-in at Cloudflare. It redeploys itself to pick the token up, which
takes a few seconds.

This way never leaves Appflare's own pages and never goes through appflare.dev, so it
works when signing in does not.

## Change how Appflare connects

While the connection works, the same choice is under **Change how Appflare connects**.
Use it to replace an API token with a new one (**Use a new API token**), or to switch
between Cloudflare sign-in and an API token on purpose. A new token must be for the
same account. Revoke the old one in the Cloudflare dashboard afterwards.

Switching changes only how Appflare reaches Cloudflare. Its address, its apps, its
users and its data stay as they are, and nothing is reinstalled. Appflare redeploys
itself to pick up the change, which takes a few seconds.

What a switch means for permissions:

- **To an API token:** Appflare can do only what the token allows. Features whose
  permissions you leave out stop working, and the pages that need them name what is
  missing.
- **To Cloudflare sign-in:** Appflare gets every permission it uses, with nothing to
  add later. It can no longer read the Workers plan from Billing. It still detects
  Workers Paid when it can tell from what the account can run; otherwise choose the
  plan under **What this account can run**.

## With Cloudflare Access in front of Appflare

When [Cloudflare Access](/security/#protect-with-cloudflare-access) protects Appflare,
Access also checks the return from a Cloudflare sign-in: appflare.dev sends it to your
Appflare's address, and it needs your Access session there to get through. Appflare's
Access application keeps Cloudflare's default cookie setting, which lets that session
come along.

If your Access session has ended, or someone changed the application's cookie setting
(SameSite) to Lax or Strict, Access stops the return and nothing changes in Appflare.
Sign in to Access at Appflare's address and start again, or use an API token, which
works whatever Access does.

## Withdraw Appflare's access

**Cloudflare sign-in.** In the Cloudflare dashboard, open
[Manage OAuth authorizations](https://dash.cloudflare.com/?to=/profile/access-management/authorization)
in your profile and select **Revoke** next to Appflare. Appflare shows **Needs
reconnecting** the next time it tries to renew its access. Your apps keep running.

**An API token.** Delete or roll the token under **API Tokens** in the Cloudflare
dashboard (**My Profile > API Tokens**, or **Manage Account > Account API Tokens** for
an account-owned token).

[Remove Appflare](/guides/danger-zone/#remove-appflare-from-this-account) withdraws a
Cloudflare sign-in by itself, as its last step. If you removed an unfinished
installation from [appflare.dev/deploy](/deploy/) after it had received its connection,
revoke Appflare in your profile as well.
