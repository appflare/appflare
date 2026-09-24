---
"@appflare/manager": minor
---

The first user, created at setup, is now the owner; on an existing manager the admin created first becomes the owner when it updates. Only the owner can change another user's role between admin and member, delete a user (their sessions, passkeys and password go with them, so they are signed out at once), or transfer ownership to another admin, confirmed by typing that admin's email; the previous owner stays an admin. The owner cannot be made a member or deleted. Admins keep everything else, adding users included, and see the list of users read-only. Settings, Users and access shows an owner badge and a menu on each row for the owner. With Cloudflare Access protection on, the allow policy follows role changes and deletions. Better Auth's own admin endpoints now give admins read access only, so they can no longer set roles, passwords or emails, delete, ban or impersonate users around these checks.

Settings, Usage data now starts with what leaving it on does (the maintainers see which versions to keep supporting, which installs and updates fail, and which features are used), then the switch, then what is and is never sent.
