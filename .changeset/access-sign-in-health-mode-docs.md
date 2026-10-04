---
"@appflare/schema": patch
---

The description of `install.health.mode` now says that Cloudflare Access's own sign-in redirect never counts as the app serving, under either mode, and that `"any-response"` is for apps whose health path asks for a sign-in, their own or one they check from Cloudflare Access.
