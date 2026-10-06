---
"@appflare/manager": minor
---

Appflare can now connect to Cloudflare with a Cloudflare authorization as well as with an API token. Managers that use an API token keep working exactly as before, with nothing to do.

With an authorization, Appflare renews its access to Cloudflare by itself, so an install or an update that runs for a long time keeps going. It saves the authorization in its own database, encrypted with a key that only this Appflare holds, separate from the key behind sign-ins. Rotating the auth secret therefore never disconnects Cloudflare. If Cloudflare stops accepting the authorization, because it was withdrawn in Cloudflare or it expired, Appflare stops trying. Home and Settings › Your account then say that an administrator must reconnect Cloudflare. Jobs that cannot run end with the same message. Your apps keep running the whole time. If Cloudflare only fails to answer for a moment, Appflare tries again and nothing changes.

An administrator can switch to an API token at any time with Change how Appflare connects on Settings › Your account. Appflare then withdraws the authorization at Cloudflare. "Remove Appflare from this account" withdraws it too, as its last step.
