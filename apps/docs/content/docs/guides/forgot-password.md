---
title: Forgot your password
description: Get back into Appflare with an emailed link, a code from an admin, or a code from your Cloudflare account.
---

Everyone who signs in to Appflare can reset a forgotten password from the sign-in
page. Select **Forgot your password?** under the password field. What happens next
depends on how your Appflare is set up.

| You have | Do this |
| --- | --- |
| Password reset emails turned on | Enter your email and select **Email me a reset link**. |
| Someone who can still sign in | The owner can give any user a recovery code; an admin can give one to a member. |
| Access to the Cloudflare account Appflare runs in | Get a recovery code yourself with `npx create-appflare recover`. |

Whichever way you use, you choose the new password yourself, and you are signed out
on every other device once it is set. Your passkeys keep working.

## Reset with an emailed link

When the owner has turned on [password reset emails](#turn-on-password-reset-emails):

1. On the sign-in page, select **Forgot your password?**.
2. Enter your email and select **Email me a reset link**.
3. Open the link in the email and choose a new password.

The link works once, for 30 minutes. Appflare gives the same answer whether or not
the address belongs to a user, so the page never tells anyone who has an account.

## Reset with a recovery code

A recovery code is 20 letters and digits, like `ABCDE-FGHJK-LMNPQ-RSTUV`. It works
once, for 30 minutes.

1. On the sign-in page, select **Forgot your password?**, then **I have a recovery
   code**.
2. Enter your email, the code, and a new password of at least 8 characters.
3. Select **Set new password**, then sign in with it.

After a few wrong tries Appflare asks you to wait ten minutes before trying again.

### Get a code from the owner or an admin

The owner can reset the password of any other user. An admin can reset a member's
password, but not another admin's. Nobody can reset the owner's password from
the manager's settings:

1. Open **Settings > Users and sign-in > Users**.
2. Open the menu at the end of the person's row and pick **Reset password**.
3. With reset emails on, choose **Email a reset link** or **Show a recovery code**.
   Without them, Appflare shows a recovery code.
4. Give the code to the person. It is shown only once; Appflare keeps only a
   fingerprint of it.

The person's current password keeps working until they set a new one. A code stops
working if its user's role changes or they become the owner before using it.

### Get a code from your Cloudflare account

This works for any admin, the owner included, and needs nothing but access to the
Cloudflare account Appflare runs in. On a computer with Node.js 22 or newer, run:

```sh
npx create-appflare recover
```

If you installed Appflare under another Worker name, add `--name <name>`. To make the
code work only for one admin, add `--email <their email>`. The command
signs in to Cloudflare the same way the installer does (it opens the login in your
browser if needed), saves a fingerprint of a new code on the Appflare Worker, and
prints the code. Being able to change that Worker is the proof that you own this
Appflare.

This is deliberate: anyone who can set secrets on the Appflare Worker, which means
anyone who controls the Cloudflare account it runs in, can reset any admin's
password, the owner's included. Keep access to the Cloudflare account as tight as
access to Appflare itself.

Saving the code restarts Appflare, so wait about ten seconds before you use it. Then
reset the password [with the code](#reset-with-a-recovery-code) and the email of the
admin whose password you are resetting. Once the code is used, Appflare removes it
from its Worker, and a code that expired or was used is also removed within half an
hour. Each run replaces the previous code. The code stops working 30 minutes after
it was saved, even if the computer that ran the command has its clock set wrong.

## Turn on password reset emails

Only the owner can turn this on. Appflare sends the emails through Cloudflare Email
Sending, from an address on a domain you have set up for it in the same Cloudflare
account. Sending to any address needs Email Sending, which needs Workers Paid. Without
it, emails reach only the addresses verified in the account's Email Routing.

1. Set up the domain for sending in the Cloudflare dashboard, under **Email Service**.
2. In Appflare, open **Settings > Users and sign-in** and find **Password reset emails**
   under **Forgotten passwords**.
3. Enter the address to send from, for example `appflare@example.com`, and select
   **Turn on**. Appflare adds an email sending binding to its own Worker and restarts,
   which takes a few seconds.
4. Select **Send me a test email** and check that it arrives.

To stop sending, select **Turn off**. People can still use recovery codes.

**Forgotten passwords** also shows the last time someone reset a password without the
old one, whose password it was, and how.
