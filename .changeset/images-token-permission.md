---
"@appflare/schema": minor
---

A catalog entry's `tokenPermissions` may ask for the account group `Images` (template key `images`; "Images Read" and "Images Write" in Cloudflare's permission group list), for apps that call the Cloudflare Images REST API with a token of their own. A Worker's Images binding needs no token. Managers from before this release read the group too, as they read any group name, and list it for the admin to add by hand in the token form instead of selecting it; the packer and catalog checks refuse it until they run this release.
