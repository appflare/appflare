---
title: Users and roles
description: Admins, members, and adding users.
---

Appflare has two roles.

| Role | Can |
| --- | --- |
| **Admin** | Everything: install, update, roll back, and uninstall apps, update Appflare, rotate the Cloudflare token, set the account's Workers plan, and add users. |
| **Member** | Read everything: installed apps, the catalog, jobs, and logs. Change nothing except their own [passkeys](#passkeys). |

The first user, created in the setup wizard, is an admin.

Members see the account's capabilities and **Workers plan** in Settings but cannot
change them. Only an admin can select **Re-check**, record the plan, or tick **Remember
this for the account** while installing or updating. A recorded plan applies only when
Appflare cannot detect it; recording Workers Paid lets later installs skip the Workers
Paid confirmation, so set it only when the account really is on Workers Paid.

## Add a user

Appflare has no email provider, so there are no invitations. Instead:

1. Open **Settings** and select **Add user**.
2. Enter an email and a name, and pick **Member (read only)** or **Admin**.
3. Select **Create user**. Appflare shows a temporary password once.
4. Copy it and give it to the person. Appflare stores only a hash; closing the dialog
   discards the password.

People sign in at `/login` with their email and password. Nobody can sign up on their
own.

## Passkeys

Every user, members included, can add passkeys to their own account. A passkey signs
you in with your fingerprint, face, screen lock, or a security key instead of your
password. Your password keeps working.

1. Open **Settings** and find **Passkeys**.
2. Select **Add passkey**. Name it after the device or password manager that keeps
   it, for example `Work laptop`, so you can tell your passkeys apart.
3. Select **Create passkey** and follow your browser's prompt.

The list shows each passkey's name, whether it is synced across your devices or kept
on this device only, and when it was added. To remove one, select its remove button
and confirm. Delete it from your device or password manager as well.

To sign in with a passkey, select **Sign in with a passkey** on the login page.

A passkey belongs to the manager's address. One added while you used
`https://appflare.<your-subdomain>.workers.dev` does not work on another hostname.
